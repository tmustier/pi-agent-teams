import * as fs from "node:fs";
import * as path from "node:path";

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
 * Recursively delete the given teamDir, but only if it's safely inside teamsRootDir.
 *
 * Uses fs.rm({ recursive: true, force: true }) so it's idempotent.
 */
export async function cleanupTeamDir(teamsRootDir: string, teamDir: string): Promise<void> {
	const { teamDirAbs } = assertTeamDirWithinTeamsRoot(teamsRootDir, teamDir);
	await fs.promises.rm(teamDirAbs, { recursive: true, force: true });
}
