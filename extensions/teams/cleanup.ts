import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupWorktrees, type WorktreeCleanupResult } from "./worktree.js";

export type CleanupResult = {
	teamDir: string;
	worktreeResult: WorktreeCleanupResult;
	warnings: string[];
};

export function assertTeamDirWithinTeamsRoot(teamsRootDir: string, teamDir: string): {
	teamsRootAbs: string;
	teamDirAbs: string;
} {
	const teamsRootAbs = path.resolve(teamsRootDir);
	const teamDirAbs = path.resolve(teamDir);

	const rel = path.relative(teamsRootAbs, teamDirAbs);
	// rel === "" => same path (would delete the whole root)
	// rel starts with ".." or is absolute => outside root
	if (!rel || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(
			`Refusing to operate on path outside teams root. teamsRootDir=${teamsRootAbs} teamDir=${teamDirAbs}`,
		);
	}

	return { teamsRootAbs, teamDirAbs };
}

/**
 * Recursively delete the given teamDir, including proper git worktree + branch removal.
 *
 * Steps:
 * 1. Remove git worktrees and branches via `cleanupWorktrees`
 * 2. Delete the team directory recursively
 *
 * Idempotent — safe to call multiple times.
 */
export async function cleanupTeamDir(
	teamsRootDir: string,
	teamDir: string,
	opts?: { teamId?: string; repoCwd?: string },
): Promise<CleanupResult> {
	const { teamDirAbs } = assertTeamDirWithinTeamsRoot(teamsRootDir, teamDir);
	const warnings: string[] = [];

	// Infer teamId from directory name if not provided.
	const teamId = opts?.teamId ?? path.basename(teamDirAbs);

	// 1. Clean up git worktrees and branches before deleting the directory.
	let worktreeResult: WorktreeCleanupResult = { removedWorktrees: [], removedBranches: [], warnings: [] };
	try {
		worktreeResult = await cleanupWorktrees({ teamDir: teamDirAbs, teamId, repoCwd: opts?.repoCwd });
		warnings.push(...worktreeResult.warnings);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`Worktree cleanup failed (non-fatal): ${msg}`);
	}

	// 2. Delete the team directory.
	await fs.promises.rm(teamDirAbs, { recursive: true, force: true });

	return { teamDir: teamDirAbs, worktreeResult, warnings };
}

/**
 * Garbage-collect stale team directories that have no active workers and are older
 * than the given threshold.
 *
 * A team directory is considered stale when:
 * - Its config.json `createdAt` (or directory mtime) is older than `maxAgeMs`
 * - It has no in_progress tasks
 * - It has no online members
 *
 * Returns a summary of what was cleaned up.
 */
export async function gcStaleTeamDirs(opts: {
	teamsRootDir: string;
	maxAgeMs: number;
	repoCwd?: string;
	dryRun?: boolean;
}): Promise<{
	scanned: number;
	removed: string[];
	skipped: Array<{ teamId: string; reason: string }>;
	warnings: string[];
}> {
	const { teamsRootDir, maxAgeMs, repoCwd, dryRun } = opts;
	const teamsRootAbs = path.resolve(teamsRootDir);
	const removed: string[] = [];
	const skipped: Array<{ teamId: string; reason: string }> = [];
	const warnings: string[] = [];

	let entries: string[];
	try {
		entries = await fs.promises.readdir(teamsRootAbs);
	} catch {
		return { scanned: 0, removed, skipped, warnings: ["teams root directory not found"] };
	}

	// Filter out non-team entries (like _styles, _hooks).
	const teamEntries = entries.filter((e) => !e.startsWith("_"));
	const now = Date.now();

	for (const teamId of teamEntries) {
		const teamDir = path.join(teamsRootAbs, teamId);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(teamDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		// Check age: prefer config.json createdAt, fall back to directory mtime.
		let ageMs: number;
		try {
			const configPath = path.join(teamDir, "config.json");
			const configRaw = await fs.promises.readFile(configPath, "utf8");
			const config: unknown = JSON.parse(configRaw);
			const createdAt = typeof config === "object" && config !== null && "createdAt" in config
				? (config as Record<string, unknown>).createdAt
				: undefined;
			if (typeof createdAt === "string") {
				const ts = Date.parse(createdAt);
				ageMs = Number.isFinite(ts) ? now - ts : now - stat.mtimeMs;
			} else {
				ageMs = now - stat.mtimeMs;
			}
		} catch {
			ageMs = now - stat.mtimeMs;
		}

		if (ageMs < maxAgeMs) {
			skipped.push({ teamId, reason: "too recent" });
			continue;
		}

		// Check for active work: in_progress tasks, online workers, or live attach claims.
		let hasActiveWork = false;
		try {
			const configPath = path.join(teamDir, "config.json");
			const configRaw = await fs.promises.readFile(configPath, "utf8");
			const config: unknown = JSON.parse(configRaw);
			if (typeof config === "object" && config !== null) {
				const members = (config as Record<string, unknown>).members;
				if (Array.isArray(members)) {
					for (const m of members) {
						if (typeof m !== "object" || m === null) continue;
						const rec = m as Record<string, unknown>;
						// Ignore the lead — it stays "online" forever and is not a signal of activity.
						if (rec.role === "lead") continue;
						if (rec.status === "online") {
							hasActiveWork = true;
							break;
						}
					}
				}
			}
		} catch {
			// No config — probably safe to remove.
		}

		// Check for a live attach claim (another session is using this team).
		if (!hasActiveWork) {
			try {
				const claimPath = path.join(teamDir, ".attach-claim.json");
				const claimRaw = await fs.promises.readFile(claimPath, "utf8");
				const claim: unknown = JSON.parse(claimRaw);
				if (typeof claim === "object" && claim !== null) {
					const heartbeatAt = (claim as Record<string, unknown>).heartbeatAt;
					if (typeof heartbeatAt === "string") {
						const hbTs = Date.parse(heartbeatAt);
						// Consider claims fresh if heartbeat is within 5 minutes.
						const claimFreshnessMs = 5 * 60 * 1000;
						if (Number.isFinite(hbTs) && now - hbTs < claimFreshnessMs) {
							hasActiveWork = true;
						}
					}
				}
			} catch {
				// No claim file or invalid — not actively attached.
			}
		}

		if (!hasActiveWork) {
			// Check task files for in_progress tasks.
			// Tasks live at tasks/<taskListId>/<id>.json — scan all subdirectories.
			try {
				const tasksDir = path.join(teamDir, "tasks");
				const taskListDirs = await fs.promises.readdir(tasksDir);
				for (const listDir of taskListDirs) {
					if (hasActiveWork) break;
					const listPath = path.join(tasksDir, listDir);
					let listStat: fs.Stats;
					try {
						listStat = await fs.promises.stat(listPath);
					} catch {
						continue;
					}
					if (!listStat.isDirectory()) continue;

					const taskFiles = await fs.promises.readdir(listPath);
					for (const tf of taskFiles) {
						if (!tf.endsWith(".json")) continue;
						try {
							const raw = await fs.promises.readFile(path.join(listPath, tf), "utf8");
							const parsed: unknown = JSON.parse(raw);
							if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).status === "in_progress") {
								hasActiveWork = true;
								break;
							}
						} catch {
							// ignore individual task read errors
						}
					}
				}
			} catch {
				// No tasks dir — fine.
			}
		}

		if (hasActiveWork) {
			skipped.push({ teamId, reason: "has active work" });
			continue;
		}

		if (dryRun) {
			removed.push(teamId);
			continue;
		}

		try {
			const result = await cleanupTeamDir(teamsRootAbs, teamDir, { teamId, repoCwd });
			warnings.push(...result.warnings);
			removed.push(teamId);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			warnings.push(`Failed to remove ${teamId}: ${msg}`);
		}
	}

	return { scanned: teamEntries.length, removed, skipped, warnings };
}
