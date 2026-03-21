import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { sanitizeName } from "./names.js";

export type WorktreeCleanupResult = {
	removedWorktrees: string[];
	removedBranches: string[];
	warnings: string[];
};

async function execGit(args: string[], opts: { cwd: string; timeoutMs?: number } ): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const msg = [
						`git ${args.join(" ")} failed`,
						`cwd=${opts.cwd}`,
						stderr ? `stderr=${String(stderr).trim()}` : "",
						err instanceof Error ? `error=${err.message}` : `error=${String(err)}`,
					]
						.filter(Boolean)
						.join("\n");
					reject(new Error(msg));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

export type WorktreeResult = {
	cwd: string;
	warnings: string[];
	mode: "worktree" | "shared";
};

/**
 * Ensure a per-teammate git worktree exists, returning the cwd to use for that teammate.
 *
 * Behavior:
 * - If not in a git repo, falls back to shared cwd with a warning.
 * - If git repo is dirty, still creates a worktree but warns that uncommitted changes are not included.
 */
export async function ensureWorktreeCwd(opts: {
	leaderCwd: string;
	teamDir: string;
	teamId: string;
	agentName: string;
}): Promise<WorktreeResult> {
	const warnings: string[] = [];
	let repoRoot: string;
	try {
		repoRoot = (await execGit(["rev-parse", "--show-toplevel"], { cwd: opts.leaderCwd })).stdout.trim();
		if (!repoRoot) throw new Error("empty git toplevel");
	} catch {
		warnings.push("Not a git repository (or git unavailable). Using shared workspace instead of worktree.");
		return { cwd: opts.leaderCwd, warnings, mode: "shared" };
	}

	try {
		const status = (await execGit(["status", "--porcelain"], { cwd: repoRoot })).stdout;
		if (status.trim().length) {
			warnings.push(
				"Git working directory is not clean. Worktree will be created from current HEAD and will NOT include your uncommitted changes.",
			);
		}
	} catch {
		// ignore status errors
	}

	const safeAgent = sanitizeName(opts.agentName);
	const shortTeam = sanitizeName(opts.teamId).slice(0, 12) || "team";
	const branch = `pi-teams/${shortTeam}/${safeAgent}`;

	const worktreesDir = path.join(opts.teamDir, "worktrees");
	const worktreePath = path.join(worktreesDir, safeAgent);
	await fs.promises.mkdir(worktreesDir, { recursive: true });

	// Reuse if it already exists.
	if (fs.existsSync(worktreePath)) {
		return { cwd: worktreePath, warnings, mode: "worktree" };
	}

	try {
		// Create worktree + new branch from HEAD
		await execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot, timeoutMs: 120_000 });
		return { cwd: worktreePath, warnings, mode: "worktree" };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// If the branch already exists (e.g. previous run), try adding worktree using the existing branch.
		if (msg.includes("already exists") || msg.includes("is already checked out")) {
			try {
				await execGit(["worktree", "add", worktreePath, branch], { cwd: repoRoot, timeoutMs: 120_000 });
				return { cwd: worktreePath, warnings, mode: "worktree" };
			} catch {
				// fall through
			}
		}

		warnings.push(`Failed to create git worktree (${branch}). Using shared workspace instead.`);
		return { cwd: opts.leaderCwd, warnings, mode: "shared" };
	}
}

/**
 * Find the git repo root from a directory that may be inside a worktree.
 * Returns null if not a git repo.
 */
async function findRepoRoot(cwd: string): Promise<string | null> {
	try {
		// --show-superproject-working-tree returns empty if not a worktree subproject.
		// Use the commondir approach: worktrees share a common git dir with the main repo.
		const commonDir = (await execGit(["rev-parse", "--git-common-dir"], { cwd })).stdout.trim();
		if (commonDir && !path.isAbsolute(commonDir)) {
			// Relative to the .git dir of the worktree — resolve upward.
			const gitDir = (await execGit(["rev-parse", "--git-dir"], { cwd })).stdout.trim();
			const absCommon = path.resolve(cwd, gitDir, commonDir);
			// The common dir is the .git directory of the main repo. Its parent is the repo root.
			return path.dirname(absCommon);
		}
		if (commonDir && path.isAbsolute(commonDir)) {
			return path.dirname(commonDir);
		}
		// Fallback: plain repo
		const toplevel = (await execGit(["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
		return toplevel || null;
	} catch {
		return null;
	}
}

/**
 * Remove all git worktrees under `<teamDir>/worktrees/` and their associated branches.
 *
 * Steps for each worktree:
 * 1. `git worktree remove --force <path>` (removes the worktree checkout)
 * 2. `git branch -D <branch>` (removes the local branch)
 * 3. Falls back to filesystem removal if git commands fail
 *
 * Also runs `git worktree prune` to clean up stale worktree bookkeeping.
 */
export async function cleanupWorktrees(opts: {
	teamDir: string;
	teamId: string;
	/** A directory known to be in the git repo (e.g. leaderCwd). */
	repoCwd?: string;
}): Promise<WorktreeCleanupResult> {
	const removedWorktrees: string[] = [];
	const removedBranches: string[] = [];
	const warnings: string[] = [];

	const worktreesDir = path.join(opts.teamDir, "worktrees");
	let entries: string[];
	try {
		entries = await fs.promises.readdir(worktreesDir);
	} catch {
		// No worktrees directory — nothing to do.
		return { removedWorktrees, removedBranches, warnings };
	}

	if (entries.length === 0) {
		return { removedWorktrees, removedBranches, warnings };
	}

	// Find the repo root. Prefer deriving from the worktree paths themselves (they belong
	// to the repo that created them), only fall back to repoCwd when none resolve.
	// This avoids cross-repo issues when cleanup targets a team created from a different repo.
	let repoRoot: string | null = null;
	for (const entry of entries) {
		const candidate = path.join(worktreesDir, entry);
		repoRoot = await findRepoRoot(candidate);
		if (repoRoot) break;
	}
	if (!repoRoot && opts.repoCwd) {
		repoRoot = await findRepoRoot(opts.repoCwd);
	}

	const shortTeam = sanitizeName(opts.teamId).slice(0, 12) || "team";

	for (const entry of entries) {
		const worktreePath = path.join(worktreesDir, entry);
		const safeAgent = sanitizeName(entry);
		const branch = `pi-teams/${shortTeam}/${safeAgent}`;

		// 1. Remove worktree via git
		if (repoRoot) {
			try {
				await execGit(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, timeoutMs: 30_000 });
				removedWorktrees.push(worktreePath);
			} catch {
				// Git removal failed — try filesystem fallback below.
				try {
					await fs.promises.rm(worktreePath, { recursive: true, force: true });
					removedWorktrees.push(worktreePath);
				} catch (fsErr: unknown) {
					const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
					warnings.push(`Failed to remove worktree ${worktreePath}: ${msg}`);
				}
			}

			// 2. Remove the associated branch
			try {
				await execGit(["branch", "-D", branch], { cwd: repoRoot });
				removedBranches.push(branch);
			} catch {
				// Branch may not exist (shared workspace fallback) — that's fine.
			}
		} else {
			// No repo root — just delete the directory.
			try {
				await fs.promises.rm(worktreePath, { recursive: true, force: true });
				removedWorktrees.push(worktreePath);
			} catch (fsErr: unknown) {
				const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
				warnings.push(`Failed to remove worktree directory ${worktreePath}: ${msg}`);
			}
		}
	}

	// 3. Prune stale worktree bookkeeping entries
	if (repoRoot) {
		try {
			await execGit(["worktree", "prune"], { cwd: repoRoot });
		} catch {
			warnings.push("git worktree prune failed (non-fatal)");
		}
	}

	// 4. Remove the now-empty worktrees directory itself
	try {
		const remaining = await fs.promises.readdir(worktreesDir);
		if (remaining.length === 0) {
			await fs.promises.rmdir(worktreesDir);
		}
	} catch {
		// ignore — best effort
	}

	return { removedWorktrees, removedBranches, warnings };
}
