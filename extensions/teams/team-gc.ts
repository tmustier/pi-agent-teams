import * as fs from "node:fs";
import * as path from "node:path";
import { getTeamsRootDir } from "./paths.js";
import { assessAttachClaimFreshness, readTeamAttachClaim } from "./team-attach-claim.js";
import { loadTeamConfig } from "./team-config.js";
import { listTasks } from "./task-store.js";
import { cleanupTeamDir } from "./cleanup.js";

export interface GcCandidate {
	teamId: string;
	teamDir: string;
	reason: string;
}

export interface GcResult {
	removed: GcCandidate[];
	skipped: { teamId: string; reason: string }[];
	errors: { teamId: string; error: string }[];
}

/**
 * Scan all team directories and identify those safe to garbage-collect.
 *
 * A team is considered dead (safe to remove) when ALL of the following are true:
 * - It is not the current session's team (`excludeTeamIds`)
 * - It has no active (non-stale) attach claim
 * - It has no online workers
 * - It has no in-progress tasks
 */
export async function findGcCandidates(opts: {
	excludeTeamIds: Set<string>;
	teamsRoot?: string;
}): Promise<{ candidates: GcCandidate[]; skipped: { teamId: string; reason: string }[] }> {
	const teamsRoot = opts.teamsRoot ?? getTeamsRootDir();
	const candidates: GcCandidate[] = [];
	const skipped: { teamId: string; reason: string }[] = [];

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(teamsRoot, { withFileTypes: true });
	} catch {
		return { candidates, skipped };
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		// Skip special directories (e.g. _styles, _hooks)
		if (entry.name.startsWith("_")) continue;

		const teamId = entry.name;
		const teamDir = path.join(teamsRoot, teamId);

		// Never GC the current session's team
		if (opts.excludeTeamIds.has(teamId)) {
			skipped.push({ teamId, reason: "current session" });
			continue;
		}

		// Load config — if missing, the directory is orphaned and safe to remove
		const cfg = await loadTeamConfig(teamDir);
		if (!cfg) {
			candidates.push({ teamId, teamDir, reason: "no config (orphaned)" });
			continue;
		}

		// Check attach claim
		const claim = await readTeamAttachClaim(teamDir);
		if (claim) {
			const freshness = assessAttachClaimFreshness(claim);
			if (!freshness.isStale) {
				skipped.push({ teamId, reason: "active attach claim" });
				continue;
			}
		}

		// Check for online workers
		const onlineWorkers = cfg.members.filter((m) => m.role === "worker" && m.status === "online");
		if (onlineWorkers.length > 0) {
			skipped.push({ teamId, reason: `${onlineWorkers.length} online worker(s)` });
			continue;
		}

		// Check for in-progress tasks
		const tasks = await listTasks(teamDir, cfg.taskListId);
		const inProgress = tasks.filter((t) => t.status === "in_progress");
		if (inProgress.length > 0) {
			skipped.push({ teamId, reason: `${inProgress.length} in-progress task(s)` });
			continue;
		}

		// Build reason summary
		const parts: string[] = [];
		if (!claim) parts.push("no attach claim");
		else parts.push("stale attach claim");
		const workerCount = cfg.members.filter((m) => m.role === "worker").length;
		if (workerCount === 0) parts.push("no workers");
		else parts.push(`${workerCount} offline worker(s)`);
		const taskCount = tasks.length;
		if (taskCount === 0) parts.push("no tasks");
		else parts.push(`${taskCount} completed/pending task(s)`);

		candidates.push({ teamId, teamDir, reason: parts.join(", ") });
	}

	return { candidates, skipped };
}

/**
 * Delete the given GC candidates. Returns a result with removed/error details.
 */
export async function gcTeamDirs(candidates: GcCandidate[], teamsRoot?: string): Promise<GcResult> {
	const root = teamsRoot ?? getTeamsRootDir();
	const result: GcResult = { removed: [], skipped: [], errors: [] };

	for (const candidate of candidates) {
		try {
			await cleanupTeamDir(root, candidate.teamDir);
			result.removed.push(candidate);
		} catch (err) {
			result.errors.push({
				teamId: candidate.teamId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}
