import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

export function getTeamDir(teamId: string): string {
	return path.join(getTeamsRootDir(), teamId);
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
