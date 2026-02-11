import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker } from "./activity-tracker.js";
import type { TeamTask } from "./task-store.js";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import {
	STATUS_COLOR,
	STATUS_ICON,
	formatTokens,
	getVisibleWorkerNames,
	padRight,
	resolveStatus,
	toolActivity,
} from "./teams-ui-shared.js";

export interface WidgetDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
	getStyle(): TeamsStyle;
	isDelegateMode(): boolean;
	getActiveTeamId(): string | null;
	getSessionTeamId(): string | null;
}

export type WidgetFactory = (tui: TUI, theme: Theme) => Component;

interface WidgetRow {
	icon: string; // raw char (before styling)
	iconColor: ThemeColor;
	displayName: string;
	statusKey: TeammateStatus;
	pending: number;
	completed: number;
	tokensStr: string; // "—" for chairman
	activityText: string;
}

function shortTeamId(teamId: string): string {
	return teamId.length <= 12 ? teamId : `${teamId.slice(0, 8)}…`;
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

				// Hide when no active team state.
				// We intentionally ignore "completed-only" task lists so the widget doesn't stick around
				// after /team shutdown.
				const hasOnlineMembers = (teamConfig?.members ?? []).some(
					(m) => m.role === "worker" && m.status === "online",
				);
				const hasActiveTasks = tasks.some((t) => t.status !== "completed");
				if (teammates.size === 0 && !hasOnlineMembers && !hasActiveTasks) {
					return [];
				}

				const lines: string[] = [];

				// ── Header line ──
				let header = " " + theme.bold(theme.fg("accent", "Teams"));
				if (delegateMode) header += " " + theme.fg("warning", "[delegate]");
				lines.push(truncateToWidth(header, width));

				const activeTeamId = deps.getActiveTeamId();
				const sessionTeamId = deps.getSessionTeamId();
				if (activeTeamId && sessionTeamId && activeTeamId !== sessionTeamId) {
					const attachLine = theme.fg(
						"warning",
						` attached: ${shortTeamId(activeTeamId)} (session ${shortTeamId(sessionTeamId)}) · /team detach`,
					);
					lines.push(truncateToWidth(attachLine, width));
				}

				// ── Build row data ──
				const cfgMembers = teamConfig?.members ?? [];
				const cfgByName = new Map<string, TeamMember>();
				for (const m of cfgMembers) cfgByName.set(m.name, m);

				const rows: WidgetRow[] = [];

				// Leader control row (always first when team is active)
				const leadName = teamConfig?.leadName;
				if (leadName) {
					const leadTasks = tasks.filter((t) => t.owner === leadName);
					rows.push({
						icon: "\u25c6",
						iconColor: "accent",
						displayName: strings.leaderControlTitle,
						statusKey: "idle",
						pending: leadTasks.filter((t) => t.status === "pending").length,
						completed: leadTasks.filter((t) => t.status === "completed").length,
						tokensStr: "\u2014",
						activityText: "",
					});
				}

				const workerNames = getVisibleWorkerNames({ teammates, teamConfig, tasks });
				if (workerNames.length === 0 && rows.length === 0) {
					lines.push(
						truncateToWidth(
							" " + theme.fg("dim", `(no ${strings.memberTitle.toLowerCase()}s)  /team spawn <name>`),
							width,
						),
					);
				} else {
					for (const name of workerNames) {
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
					for (const name of workerNames) totalTokensRaw += tracker.get(name).totalTokens;
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
					// nameColWidth + 4 = " ◆ " + name; then " " + pctLabel fills the status column
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
