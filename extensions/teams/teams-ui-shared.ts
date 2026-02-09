import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamTask } from "./task-store.js";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";

// Status icon and color mapping (shared by widget + interactive panel)
export const STATUS_ICON: Record<TeammateStatus, string> = {
	streaming: "\u25c9",
	idle: "\u25cf",
	starting: "\u25cb",
	stopped: "\u2717",
	error: "\u2717",
};

export const STATUS_COLOR: Record<TeammateStatus, ThemeColor> = {
	streaming: "accent",
	idle: "success",
	starting: "muted",
	stopped: "dim",
	error: "error",
};

export const TOOL_VERB: Record<string, string> = {
	read: "reading\u2026",
	edit: "editing\u2026",
	write: "writing\u2026",
	grep: "searching\u2026",
	glob: "finding files\u2026",
	bash: "running\u2026",
	task: "delegating\u2026",
	webfetch: "fetching\u2026",
	websearch: "searching web\u2026",
};

export function toolVerb(toolName: string): string {
	const key = toolName.toLowerCase();
	return TOOL_VERB[key] ?? `${toolName}\u2026`;
}

export function toolActivity(toolName: string | null): string {
	if (!toolName) return "";
	return toolVerb(toolName);
}

export function padRight(str: string, targetWidth: number): string {
	const w = visibleWidth(str);
	return w >= targetWidth ? str : str + " ".repeat(targetWidth - w);
}

export function resolveStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): TeammateStatus {
	if (rpc) return rpc.status;
	return cfg?.status === "online" ? "idle" : "stopped";
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Compute the set of worker names that should be visible in the UI.
 *
 * Rule: show any worker that is:
 * - currently spawned/known as a teammate RPC
 * - online in team config
 * - owning an in-progress task (even if RPC is disconnected)
 */
export function getVisibleWorkerNames(opts: {
	teammates: ReadonlyMap<string, TeammateRpc>;
	teamConfig: TeamConfig | null;
	tasks: readonly TeamTask[];
}): string[] {
	const { teammates, teamConfig, tasks } = opts;
	const leadName = teamConfig?.leadName;
	const cfgMembers = teamConfig?.members ?? [];

	const names = new Set<string>();
	for (const name of teammates.keys()) names.add(name);
	for (const m of cfgMembers) {
		if (m.role === "worker" && m.status === "online") names.add(m.name);
	}
	for (const t of tasks) {
		if (t.owner && t.owner !== leadName && t.status === "in_progress") names.add(t.owner);
	}

	return Array.from(names).sort();
}
