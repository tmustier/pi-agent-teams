import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { sanitizeName } from "./names.js";

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
