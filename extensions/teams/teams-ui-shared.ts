import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamTask } from "./task-store.js";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import {
	areTeamsHooksEnabled,
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
} from "./hooks.js";
import {
	formatProviderModel,
	isDeprecatedTeammateModelId,
	resolveTeammateModelSelection,
} from "./model-policy.js";

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

/** Display-only status that extends TeammateStatus with a "stalled" state. */
export type DisplayStatus = TeammateStatus | "stalled";

export const DISPLAY_STATUS_ICON: Record<DisplayStatus, string> = {
	...STATUS_ICON,
	stalled: "\u26a0",
};

export const DISPLAY_STATUS_COLOR: Record<DisplayStatus, ThemeColor> = {
	...STATUS_COLOR,
	stalled: "warning",
};

/**
 * Default stall threshold in milliseconds.
 * Configurable via PI_TEAMS_STALL_THRESHOLD_MS env var.
 */
function getStallThresholdMs(): number {
	const envVal = process.env.PI_TEAMS_STALL_THRESHOLD_MS;
	if (envVal) {
		const parsed = Number.parseInt(envVal, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return 5 * 60 * 1000; // 5 minutes default
}

/**
 * Resolve the display status for a teammate, including stall detection.
 *
 * A teammate is "stalled" when:
 * - It has an active RPC connection
 * - Its transport status is "streaming" (i.e. not idle/stopped/error)
 * - No agent event has been received for > stallThresholdMs
 */
export function resolveDisplayStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): DisplayStatus {
	if (!rpc) return cfg?.status === "online" ? "idle" : "stopped";

	if (rpc.status === "streaming") {
		const elapsed = Date.now() - rpc.lastEventAt;
		if (elapsed > getStallThresholdMs()) return "stalled";
	}
	return rpc.status;
}

export function resolveStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): TeammateStatus {
	if (rpc) return rpc.status;
	return cfg?.status === "online" ? "idle" : "stopped";
}

/**
 * Format elapsed duration as a compact human-readable string.
 * e.g. "2s", "45s", "3m12s", "1h5m"
 */
export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMin = minutes % 60;
	return remainingMin > 0 ? `${hours}h${remainingMin}m` : `${hours}h`;
}

/**
 * Get a compact summary of the last assistant text (first 100 visible chars).
 */
export function lastMessageSummary(rpc: TeammateRpc | undefined, maxLen: number = 100): string {
	if (!rpc) return "";
	const raw = rpc.lastAssistantText;
	if (!raw) return "";
	const compact = raw.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Check if all tasks are completed and all teammates are idle/stopped.
 * Used by the widget (done hint) and leader (auto-done detection).
 */
export function isTeamDone(
	tasks: readonly TeamTask[],
	teammates: ReadonlyMap<string, TeammateRpc>,
): boolean {
	if (tasks.length === 0) return false;
	const pending = tasks.filter((t) => t.status === "pending").length;
	const inProgress = tasks.filter((t) => t.status === "in_progress").length;
	if (pending > 0 || inProgress > 0) return false;
	for (const [, rpc] of teammates) {
		if (rpc.status === "streaming" || rpc.status === "starting") return false;
	}
	return true;
}

/**
 * Extract the model label from a TeamMember's freeform metadata.
 *
 * Stored as `meta.model` (e.g. "anthropic/claude-sonnet-4-5-20250514").
 * Returns a short display form: strips the provider prefix and long date
 * suffixes to keep the widget compact.
 */
export function getMemberModel(member: TeamMember | undefined): string | null {
	const raw = member?.meta?.["model"];
	if (typeof raw !== "string" || !raw) return null;
	return raw;
}

/**
 * Shorten a full model identifier for display in compact UI contexts.
 *
 * Examples:
 * - "anthropic/claude-sonnet-4-5-20250514" → "claude-sonnet-4-5"
 * - "openai-codex/gpt-5.1-codex-mini" → "gpt-5.1-codex-mini"
 * - "claude-sonnet-4-5-20250514" → "claude-sonnet-4-5"
 */
export function shortModelLabel(fullModel: string): string {
	// Strip provider prefix (everything before and including the first "/")
	const slashIdx = fullModel.indexOf("/");
	const modelId = slashIdx >= 0 ? fullModel.slice(slashIdx + 1) : fullModel;
	// Strip trailing date suffixes like -20250514 or -20250514-v2
	return modelId.replace(/-\d{8}(-\w+)?$/, "");
}

/**
 * Extract the thinking level from a TeamMember's freeform metadata.
 *
 * Stored as `meta.thinkingLevel` (e.g. "high", "medium", "off").
 */
export function getMemberThinking(member: TeamMember | undefined): string | null {
	const raw = member?.meta?.["thinkingLevel"];
	if (typeof raw !== "string" || !raw) return null;
	return raw;
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

// ── Policy summary (shared by widget + interactive panel) ──

export interface LeaderModelInfo {
	provider: string | undefined;
	modelId: string | undefined;
}

/**
 * Render a compact policy summary line for the Teams UI.
 *
 * Shows hook policy (failureAction, maxReopens, followupOwner) and model
 * policy (leader model, deprecation, teammate source) as a single dim line.
 */
export function renderPolicySummary(opts: {
	teamConfig: TeamConfig | null;
	leaderModel: LeaderModelInfo | null;
	theme: Theme;
	width: number;
}): string[] {
	const { teamConfig, leaderModel, theme, width } = opts;
	if (!teamConfig) return [];

	const lines: string[] = [];

	// ── Hooks policy ──
	const hooksEnabled = areTeamsHooksEnabled();
	const hooksCfg = teamConfig.hooks;
	const failureAction = getTeamsHookFailureAction(process.env, hooksCfg?.failureAction);
	const maxReopens = getTeamsHookMaxReopensPerTask(process.env, hooksCfg?.maxReopensPerTask);
	const followupOwner = getTeamsHookFollowupOwnerPolicy(process.env, hooksCfg?.followupOwner);

	const hooksLabel = hooksEnabled ? "on" : "off";
	const hooksColor: ThemeColor = hooksEnabled ? "success" : "dim";
	const hookLine =
		` ${theme.fg("dim", "hooks:")} ${theme.fg(hooksColor, hooksLabel)}` +
		(hooksEnabled
			? theme.fg("dim", ` · failure=${failureAction} · reopens=${String(maxReopens)} · owner=${followupOwner}`)
			: "");
	lines.push(truncateToWidth(hookLine, width));

	// ── Model policy ──
	const leaderProvider = leaderModel?.provider;
	const leaderModelId = leaderModel?.modelId;
	const leaderDisplay = formatProviderModel(leaderProvider, leaderModelId) ?? "(unknown)";
	const deprecated = leaderModelId ? isDeprecatedTeammateModelId(leaderModelId) : false;
	const resolved = resolveTeammateModelSelection({ leaderProvider, leaderModelId });
	let teammateSource = "(default)";
	if (resolved.ok) {
		const src = resolved.value.source;
		const resolvedModel = formatProviderModel(resolved.value.provider, resolved.value.modelId);
		teammateSource = src === "inherit_leader" ? "inherit" : src;
		if (resolvedModel) teammateSource += `:${resolvedModel}`;
	}

	const deprecTag = deprecated ? theme.fg("warning", " [deprecated]") : "";
	const modelLine =
		` ${theme.fg("dim", "model:")} ${theme.fg("muted", leaderDisplay)}${deprecTag}` +
		theme.fg("dim", ` · teammate=${teammateSource}`);
	lines.push(truncateToWidth(modelLine, width));

	return lines;
}
