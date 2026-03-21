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
