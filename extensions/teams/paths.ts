import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * Root directory for all team artifacts (config, sessions, mailboxes, tasks).
 *
 * Default: `${getAgentDir()}/teams`
 * Override: set `PI_TEAMS_ROOT_DIR` to an absolute path (recommended) or a path
 * relative to the agent dir.
 */
export function getTeamsRootDir(): string {
	const override = process.env.PI_TEAMS_ROOT_DIR;
	if (override && override.trim()) {
		const p = override.trim();
		return path.isAbsolute(p) ? p : path.join(getAgentDir(), p);
	}
	return path.join(getAgentDir(), "teams");
}

export function validateTeamId(teamId: string): string | null {
	if (!teamId || teamId.trim() !== teamId) return "teamId must be non-empty and have no leading/trailing whitespace";
	if (teamId === "." || teamId === ".." || teamId.includes("..")) return "teamId must not contain traversal segments";
	if (path.isAbsolute(teamId) || teamId.includes("/") || teamId.includes("\\")) return "teamId must not contain path separators";
	return null;
}

export function assertValidTeamId(teamId: string): void {
	const err = validateTeamId(teamId);
	if (err) throw new Error(`Invalid teamId ${JSON.stringify(teamId)}: ${err}`);
}

export function getTeamDir(teamId: string): string {
	assertValidTeamId(teamId);
	const root = path.resolve(getTeamsRootDir());
	const dir = path.resolve(root, teamId);
	const rel = path.relative(root, dir);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Invalid teamId ${JSON.stringify(teamId)}: outside teams root`);
	return dir;
}

/** Directory for custom team UI styles (terminology + name rules). */
export function getTeamsStylesDir(): string {
	return path.join(getTeamsRootDir(), "_styles");
}

/** Directory for hook scripts and hook configuration (quality gates). */
export function getTeamsHooksDir(): string {
	const override = process.env.PI_TEAMS_HOOKS_DIR;
	if (override && override.trim()) {
		const p = override.trim();
		return path.isAbsolute(p) ? p : path.join(getTeamsRootDir(), p);
	}
	return path.join(getTeamsRootDir(), "_hooks");
}
