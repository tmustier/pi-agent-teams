import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker } from "./activity-tracker.js";
import type { TeamTask } from "./task-store.js";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

export interface InteractiveWidgetDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
	getStyle(): TeamsStyle;
	isDelegateMode(): boolean;
	sendMessage(name: string, message: string): Promise<void>;
	abortComrade(name: string): void;
	killComrade(name: string): void;
	restoreWidget(): void;
}

// ── Status icon + color (shared with teams-widget.ts) ──

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

// ── Helpers ──

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

function toolActivity(toolName: string | null): string {
	if (!toolName) return "";
	const key = toolName.toLowerCase();
	return TOOL_VERB[key] ?? `${key}\u2026`;
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getComradeNames(deps: InteractiveWidgetDeps): string[] {
	const teamConfig = deps.getTeamConfig();
	const teammates = deps.getTeammates();
	const tasks = deps.getTasks();
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

// ── Row data (mirrors teams-widget.ts) ──

interface Row {
	icon: string;
	iconColor: ThemeColor;
	name: string;
	displayName: string;
	statusKey: TeammateStatus;
	pending: number;
	completed: number;
	tokensStr: string;
	activityText: string;
	isChairman: boolean;
}

type WidgetMode = "overview" | "session" | "dm";

// ── Main export ──

export async function openInteractiveWidget(ctx: ExtensionCommandContext, deps: InteractiveWidgetDeps): Promise<void> {
	const style = deps.getStyle();
	const strings = getTeamsStrings(style);
	const names = getComradeNames(deps);
	if (names.length === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s to show`, "info");
		return;
	}

	// Hide persistent widget while interactive one is open.
	ctx.ui.setWidget("pi-teams", undefined);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				let mode: WidgetMode = "overview";
				let cursorIndex = 0;
				let sessionName: string | null = null;
				let dmTarget: string | null = null;
				let dmBuffer = "";
				let notification: { text: string; color: ThemeColor } | null = null;
				let notificationTimer: ReturnType<typeof setTimeout> | null = null;

				const refreshInterval = setInterval(() => tui.requestRender(), 1000);

				function showNotification(text: string, color: ThemeColor = "success") {
					notification = { text, color };
					if (notificationTimer) clearTimeout(notificationTimer);
					notificationTimer = setTimeout(() => {
						notification = null;
						tui.requestRender();
					}, 3000);
					tui.requestRender();
				}

				// ── Build row data (same logic as persistent widget) ──

				function buildRows(): { rows: Row[]; comradeNames: string[] } {
					const teammates = deps.getTeammates();
					const tracker = deps.getTracker();
					const tasks = deps.getTasks();
					const teamConfig = deps.getTeamConfig();
					const leadName = teamConfig?.leadName;
					const cfgMembers = teamConfig?.members ?? [];
					const cfgByName = new Map<string, TeamMember>();
					for (const m of cfgMembers) cfgByName.set(m.name, m);

					const rows: Row[] = [];

					// Chairman
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
							isChairman: true,
							name: leadName,
						});
					}

					// Comrades
					const comradeNames = getComradeNames(deps);
					for (const name of comradeNames) {
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
							isChairman: false,
							name,
						});
					}

					return { rows, comradeNames };
				}

				// ── Overview render (identical to persistent widget + cursor) ──

				function renderOverview(width: number): string[] {
					const tasks = deps.getTasks();
					const tracker = deps.getTracker();
					const delegateMode = deps.isDelegateMode();
					const { rows, comradeNames } = buildRows();

					// Clamp cursor
					if (cursorIndex >= comradeNames.length) cursorIndex = Math.max(0, comradeNames.length - 1);

					const lines: string[] = [];

					// Header
					let header = " " + theme.bold(theme.fg("accent", "Teams"));
					if (delegateMode) header += " " + theme.fg("warning", "[delegate]");
					lines.push(truncateToWidth(header, width));

					if (rows.length === 0) {
						lines.push(
							truncateToWidth(
							" " + theme.fg("dim", `(no ${strings.memberTitle.toLowerCase()}s)  /team spawn <name>`),
							width,
						),
						);
					} else {
						// Column widths
						const totalPending = tasks.filter((t) => t.status === "pending").length;
						const totalCompleted = tasks.filter((t) => t.status === "completed").length;
						let totalTokensRaw = 0;
						for (const name of comradeNames) totalTokensRaw += tracker.get(name).totalTokens;
						const totalTokensStr = formatTokens(totalTokensRaw);

						const nameColWidth = Math.max(...rows.map((r) => visibleWidth(r.displayName)));
						const pW = Math.max(
							...rows.map((r) => String(r.pending).length),
							String(totalPending).length,
						);
						const cW = Math.max(
							...rows.map((r) => String(r.completed).length),
							String(totalCompleted).length,
						);
						const tokW = Math.max(
							...rows.map((r) => r.tokensStr.length),
							totalTokensStr.length,
						);

						// Render rows
						for (const r of rows) {
							const isSelected = !r.isChairman && comradeNames.indexOf(r.name) === cursorIndex;
							const pointer = isSelected ? theme.fg("accent", "\u25b8") : " ";
							const icon = theme.fg(r.iconColor, r.icon);
							const styledName = isSelected
								? theme.bold(theme.fg("accent", r.displayName))
								: theme.bold(r.displayName);
							const statusLabel = theme.fg(STATUS_COLOR[r.statusKey], padRight(r.statusKey, 9));
							const pNum = String(r.pending).padStart(pW);
							const cNum = String(r.completed).padStart(cW);
							const tokStr = r.tokensStr.padStart(tokW);
							const cols = theme.fg(
								"dim",
								` \u00b7 ${pNum} pending \u00b7 ${cNum} complete \u00b7 ${tokStr} tokens`,
							);
							const actLabel = r.activityText
								? "  " + theme.fg("warning", r.activityText)
								: "";

							const row = `${pointer}${icon} ${padRight(styledName, nameColWidth)} ${statusLabel}${cols}${actLabel}`;
							lines.push(truncateToWidth(row, width));
						}

						// Separator + Total
						const sepLine = " " + theme.fg("dim", "\u2500".repeat(Math.max(0, width - 2)));
						lines.push(truncateToWidth(sepLine, width));

						const totalLabel = theme.bold("Total");
						const totalTaskCount = totalPending + totalCompleted;
						const pct =
							totalTaskCount > 0 ? Math.round((totalCompleted / totalTaskCount) * 100) : 0;
						const pctLabel = theme.fg("success", padRight(`${pct}%`, 9));
						const tpNum = String(totalPending).padStart(pW);
						const tcNum = String(totalCompleted).padStart(cW);
						const ttokStr = totalTokensStr.padStart(tokW);
						const totalSuffix = theme.fg(
							"muted",
							` \u00b7 ${tpNum} pending \u00b7 ${tcNum} complete \u00b7 ${ttokStr} tokens`,
						);
						const totalRow = ` ${padRight(totalLabel, nameColWidth + 3)} ${pctLabel}${totalSuffix}`;
						lines.push(truncateToWidth(totalRow, width));
					}

					// Notification
					if (notification) {
						lines.push(truncateToWidth(" " + theme.fg(notification.color, notification.text), width));
					}

					// Hints
					const hints = theme.fg(
						"dim",
						" \u2191\u2193 select \u00b7 enter view \u00b7 m message \u00b7 a abort \u00b7 k kill \u00b7 esc close",
					);
					lines.push(truncateToWidth(hints, width));

					return lines;
				}

				// ── Session render ──

				function renderSession(width: number): string[] {
					if (!sessionName) return renderOverview(width);

					const rpc = deps.getTeammates().get(sessionName);
					const cfg = (deps.getTeamConfig()?.members ?? []).find((m) => m.name === sessionName);
					const statusKey = resolveStatus(rpc, cfg);
					const activity = deps.getTracker().get(sessionName);
					const tasks = deps.getTasks();
					const activeTask = tasks.find(
						(t) => t.owner === sessionName && t.status === "in_progress",
					);

					const lines: string[] = [];
					const sep = theme.fg("dim", "\u2500".repeat(Math.max(0, width - 2)));

					// Header
					const icon = theme.fg(STATUS_COLOR[statusKey], STATUS_ICON[statusKey]);
					const name = theme.bold(theme.fg("accent", formatMemberDisplayName(style, sessionName)));
					const status = theme.fg(STATUS_COLOR[statusKey], statusKey);
					const tokens = theme.fg("dim", `${formatTokens(activity.totalTokens)} tokens`);
					lines.push(truncateToWidth(` ${icon} ${name} \u2014 ${status} \u00b7 ${tokens}`, width));
					lines.push(truncateToWidth(` ${sep}`, width));

					// Task
					if (activeTask) {
						lines.push(
							truncateToWidth(
								` ${theme.fg("muted", "task:")} #${String(activeTask.id)} ${activeTask.subject}`,
								width,
							),
						);
					}

					// Current tool + stats
					if (activity.currentToolName) {
						lines.push(
							truncateToWidth(
								` ${theme.fg("muted", "tool:")} ${theme.fg("warning", activity.currentToolName)}`,
								width,
							),
						);
					}
					lines.push(
						truncateToWidth(
							` ${theme.fg("muted", "stats:")} ${theme.fg("dim", `${String(activity.toolUseCount)} tools \u00b7 ${String(activity.turnCount)} turns`)}`,
							width,
						),
					);

					// Recent events (last 5)
					const recent = activity.recentEvents.slice(-5);
					if (recent.length > 0) {
						lines.push(truncateToWidth(` ${theme.fg("muted", "recent:")}`, width));
						for (const ev of recent) {
							const ts = formatTimestamp(ev.timestamp);
							const tool = ev.toolName ? ` ${ev.toolName}` : "";
							lines.push(
								truncateToWidth(`   ${theme.fg("dim", `${ts} ${ev.type}${tool}`)}`, width),
							);
						}
					}

					// Last assistant text (last ~10 lines)
					if (rpc && rpc.lastAssistantText.trim()) {
						lines.push(truncateToWidth(` ${sep}`, width));
						const textLines = rpc.lastAssistantText.trim().split("\n").slice(-10);
						for (const tl of textLines) {
							lines.push(
								truncateToWidth(` ${theme.fg("dim", theme.italic(tl))}`, width),
							);
						}
					}

					// Notification
					if (notification) {
						lines.push(
							truncateToWidth(" " + theme.fg(notification.color, notification.text), width),
						);
					}

					// Hints
					lines.push(truncateToWidth(` ${sep}`, width));
					const hints = theme.fg(
						"dim",
						" m message \u00b7 a abort \u00b7 k kill \u00b7 esc back",
					);
					lines.push(truncateToWidth(hints, width));

					return lines;
				}

				// ── DM render ──

				function renderDm(width: number): string[] {
					const lines: string[] = [];
					const sep = theme.fg("dim", "\u2500".repeat(Math.max(0, width - 2)));

					lines.push(
						truncateToWidth(
							` ${theme.bold(theme.fg("accent", `Message to ${formatMemberDisplayName(style, dmTarget ?? "")}`))}`,
							width,
						),
					);
					lines.push(truncateToWidth(` ${sep}`, width));
					lines.push(
						truncateToWidth(` ${theme.fg("accent", "\u25b8")} ${dmBuffer}\u2588`, width),
					);
					lines.push(truncateToWidth(` ${sep}`, width));
					lines.push(
						truncateToWidth(` ${theme.fg("dim", "enter send \u00b7 esc cancel")}`, width),
					);

					return lines;
				}

				// ── Component ──

				return {
					render(width: number): string[] {
						switch (mode) {
							case "overview":
								return renderOverview(width);
							case "session":
								return renderSession(width);
							case "dm":
								return renderDm(width);
						}
					},

					handleInput(data: string): void {
						// ── DM mode ──
						if (mode === "dm") {
							if (matchesKey(data, "escape")) {
								mode = sessionName ? "session" : "overview";
								dmBuffer = "";
								dmTarget = null;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "enter")) {
								if (dmBuffer.trim() && dmTarget) {
									const msg = dmBuffer.trim();
									const target = dmTarget;
									void deps.sendMessage(target, msg);
									showNotification(`Message sent to ${formatMemberDisplayName(style, target)}`);
									dmBuffer = "";
									mode = sessionName ? "session" : "overview";
									dmTarget = null;
								}
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "backspace")) {
								dmBuffer = dmBuffer.slice(0, -1);
								tui.requestRender();
								return;
							}
							// Regular character input
							if (data.length === 1 && data.charCodeAt(0) >= 32) {
								dmBuffer += data;
								tui.requestRender();
								return;
							}
							return;
						}

						// ── Session mode ──
						if (mode === "session") {
							if (matchesKey(data, "escape")) {
								mode = "overview";
								sessionName = null;
								tui.requestRender();
								return;
							}
							if (data === "m") {
								dmTarget = sessionName;
								mode = "dm";
								dmBuffer = "";
								tui.requestRender();
								return;
							}
							if (data === "a") {
								if (sessionName) {
									deps.abortComrade(sessionName);
									showNotification(`Abort sent to ${formatMemberDisplayName(style, sessionName)}`, "warning");
								}
								return;
							}
							if (data === "k") {
								if (sessionName) {
									const name = sessionName;
									deps.killComrade(name);
									showNotification(`${formatMemberDisplayName(style, name)} ${strings.killedVerb}`, "error");
									mode = "overview";
									sessionName = null;
									tui.requestRender();
								}
								return;
							}
							return;
						}

						// ── Overview mode ──
						const comradeNames = getComradeNames(deps);

						if (matchesKey(data, "escape") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up")) {
							cursorIndex = Math.max(0, cursorIndex - 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "down")) {
							cursorIndex = Math.min(comradeNames.length - 1, cursorIndex + 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "enter")) {
							const name = comradeNames[cursorIndex];
							if (name) {
								sessionName = name;
								mode = "session";
								tui.requestRender();
							}
							return;
						}
						if (data === "m") {
							const name = comradeNames[cursorIndex];
							if (name) {
								dmTarget = name;
								mode = "dm";
								dmBuffer = "";
								tui.requestRender();
							}
							return;
						}
						if (data === "a") {
							const name = comradeNames[cursorIndex];
							if (name) {
								deps.abortComrade(name);
								showNotification(`Abort sent to ${formatMemberDisplayName(style, name)}`, "warning");
							}
							return;
						}
						if (data === "k") {
							const name = comradeNames[cursorIndex];
							if (name) {
								deps.killComrade(name);
								showNotification(`${formatMemberDisplayName(style, name)} ${strings.killedVerb}`, "error");
								tui.requestRender();
							}
							return;
						}
					},

					invalidate() {},

					dispose() {
						clearInterval(refreshInterval);
						if (notificationTimer) clearTimeout(notificationTimer);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "60%",
					margin: 0,
				},
			},
		);
	} finally {
		deps.restoreWidget();
	}
}
