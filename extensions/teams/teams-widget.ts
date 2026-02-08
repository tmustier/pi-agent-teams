import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker } from "./activity-tracker.js";
import type { TeamTask } from "./task-store.js";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

export interface WidgetDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
	getStyle(): TeamsStyle;
	isDelegateMode(): boolean;
}

export type WidgetFactory = (tui: TUI, theme: Theme) => Component;

// Status icon and color mapping
const STATUS_ICON: Record<TeammateStatus, string> = {
	streaming: "\u25c9",
	idle: "\u25cf",
	starting: "\u25cb",
	stopped: "\u2717",
	error: "\u2717",
};

const STATUS_COLOR: Record<TeammateStatus, ThemeColor> = {
	streaming: "accent",
	idle: "success",
	starting: "muted",
	stopped: "dim",
	error: "error",
};

function padRight(str: string, targetWidth: number): string {
	const w = visibleWidth(str);
	return w >= targetWidth ? str : str + " ".repeat(targetWidth - w);
}

function resolveStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): TeammateStatus {
	if (rpc) return rpc.status;
	return cfg?.status === "online" ? "idle" : "stopped";
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const TOOL_VERB: Record<string, string> = {
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

function toolActivity(toolName: string | null): string {
	if (!toolName) return "";
	const key = toolName.toLowerCase();
	return TOOL_VERB[key] ?? `${key}\u2026`;
}

interface WidgetRow {
	icon: string; // raw char (before styling)
	iconColor: ThemeColor;
	displayName: string;
	statusKey: TeammateStatus;
	pending: number;
	completed: number;
	tokensStr: string; // "\u2014" for chairman
	activityText: string;
}

export function createTeamsWidget(deps: WidgetDeps): WidgetFactory {
	return (_tui: TUI, theme: Theme): Component => {
		return {
			render(width: number): string[] {
				const teammates = deps.getTeammates();
				const tracker = deps.getTracker();
				const tasks = deps.getTasks();
				const teamConfig = deps.getTeamConfig();
				const style = deps.getStyle();
				const strings = getTeamsStrings(style);
				const delegateMode = deps.isDelegateMode();

				// Hide when no active team state
				const hasOnlineMembers = (teamConfig?.members ?? []).some(
					(m) => m.role === "worker" && m.status === "online",
				);
				if (teammates.size === 0 && tasks.length === 0 && !hasOnlineMembers) {
					return [];
				}

				const lines: string[] = [];

				// ── Header line ──
				let header = " " + theme.bold(theme.fg("accent", "Teams"));
				if (delegateMode) header += " " + theme.fg("warning", "[delegate]");
				lines.push(truncateToWidth(header, width));

				// ── Build row data ──
				const cfgMembers = teamConfig?.members ?? [];
				const cfgByName = new Map<string, TeamMember>();
				for (const m of cfgMembers) cfgByName.set(m.name, m);

				const rows: WidgetRow[] = [];

				// Chairman row (always first when team is active)
				const leadName = teamConfig?.leadName;
				if (leadName) {
					const leadTasks = tasks.filter((t) => t.owner === leadName);
					rows.push({
						icon: "\u25c6",
						iconColor: "accent",
						displayName: strings.leaderTitle,
						statusKey: "idle",
						pending: leadTasks.filter((t) => t.status === "pending").length,
						completed: leadTasks.filter((t) => t.status === "completed").length,
						tokensStr: "\u2014",
						activityText: "",
					});
				}

				// Comrade rows
				const visibleNames = new Set<string>();
				for (const name of teammates.keys()) visibleNames.add(name);
				for (const m of cfgMembers) {
					if (m.role === "worker" && m.status === "online") visibleNames.add(m.name);
				}
				for (const t of tasks) {
					if (t.owner && t.owner !== leadName && t.status === "in_progress") visibleNames.add(t.owner);
				}

				if (visibleNames.size === 0 && rows.length === 0) {
					lines.push(
						truncateToWidth(
							" " + theme.fg("dim", `(no ${strings.memberTitle.toLowerCase()}s)  /team spawn <name>`),
							width,
						),
					);
				} else {
					const sortedNames = Array.from(visibleNames).sort();
					for (const name of sortedNames) {
						const rpc = teammates.get(name);
						const cfg = cfgByName.get(name);
						const statusKey = resolveStatus(rpc, cfg);
						const activity = tracker.get(name);
						const owned = tasks.filter((t) => t.owner === name);

						rows.push({
							icon: STATUS_ICON[statusKey],
							iconColor: STATUS_COLOR[statusKey],
							displayName: formatMemberDisplayName(style, name),
							statusKey,
							pending: owned.filter((t) => t.status === "pending").length,
							completed: owned.filter((t) => t.status === "completed").length,
							tokensStr: formatTokens(activity.totalTokens),
							activityText: toolActivity(activity.currentToolName),
						});
					}

					// ── Compute column widths ──
					const totalPending = tasks.filter((t) => t.status === "pending").length;
					const totalCompleted = tasks.filter((t) => t.status === "completed").length;
					let totalTokensRaw = 0;
					for (const name of sortedNames) totalTokensRaw += tracker.get(name).totalTokens;
					const totalTokensStr = formatTokens(totalTokensRaw);

					const nameColWidth = Math.max(...rows.map((r) => visibleWidth(r.displayName)));
					const pW = Math.max(...rows.map((r) => String(r.pending).length), String(totalPending).length);
					const cW = Math.max(...rows.map((r) => String(r.completed).length), String(totalCompleted).length);
					const tokW = Math.max(...rows.map((r) => r.tokensStr.length), totalTokensStr.length);

					// ── Render rows ──
					for (const r of rows) {
						const icon = theme.fg(r.iconColor, r.icon);
						const styledName = theme.bold(r.displayName);
						const statusLabel = theme.fg(STATUS_COLOR[r.statusKey], padRight(r.statusKey, 9));
						const pNum = String(r.pending).padStart(pW);
						const cNum = String(r.completed).padStart(cW);
						const tokStr = r.tokensStr.padStart(tokW);
						const cols = theme.fg(
							"dim",
							` \u00b7 ${pNum} pending \u00b7 ${cNum} complete \u00b7 ${tokStr} tokens`,
						);
						const actLabel = r.activityText ? "  " + theme.fg("warning", r.activityText) : "";

						const row = ` ${icon} ${padRight(styledName, nameColWidth)} ${statusLabel}${cols}${actLabel}`;
						lines.push(truncateToWidth(row, width));
					}

					// ── Total row ──
					const leftWidth = nameColWidth + 13;
					const sepLine = " " + theme.fg("dim", "\u2500".repeat(Math.max(0, width - 2)));
					lines.push(truncateToWidth(sepLine, width));

					const totalLabel = theme.bold("Total");
					const totalTaskCount = totalPending + totalCompleted;
					const pct = totalTaskCount > 0 ? Math.round((totalCompleted / totalTaskCount) * 100) : 0;
					const pctLabel = theme.fg("success", padRight(`${pct}%`, 9));
					const tpNum = String(totalPending).padStart(pW);
					const tcNum = String(totalCompleted).padStart(cW);
					const ttokStr = totalTokensStr.padStart(tokW);
					const totalSuffix = theme.fg(
						"muted",
						` \u00b7 ${tpNum} pending \u00b7 ${tcNum} complete \u00b7 ${ttokStr} tokens`,
					);
					// nameColWidth + 4 = " ◆ " + name;  then " " + pctLabel fills the status column
					const totalRow = ` ${padRight(totalLabel, nameColWidth + 3)} ${pctLabel}${totalSuffix}`;
					lines.push(truncateToWidth(totalRow, width));
				}

				// ── Hints line ──
				const hints = theme.fg(
					"dim",
					" /team widget \u00b7 /team dm <name> <msg> \u00b7 /team task list",
				);
				lines.push(truncateToWidth(hints, width));

				return lines;
			},
			invalidate() {},
		};
	};
}
