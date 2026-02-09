import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker, TranscriptLog, TranscriptEntry } from "./activity-tracker.js";
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
	toolVerb,
} from "./teams-ui-shared.js";

export interface InteractiveWidgetDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTranscript(name: string): TranscriptLog;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
	getStyle(): TeamsStyle;
	isDelegateMode(): boolean;
	sendMessage(name: string, message: string): Promise<void>;
	abortMember(name: string): void;
	killMember(name: string): void;
	suppressWidget(): void;
	restoreWidget(): void;
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

// ── Transcript formatting ──

function formatTranscriptEntry(entry: TranscriptEntry, theme: Theme, width: number): string[] {
	const ts = formatTimestamp(entry.timestamp);
	const tsStr = theme.fg("dim", ts);
	const maxTextWidth = width - 12; // " HH:MM:SS  " prefix

	if (entry.kind === "text") {
		// Wrap long text lines
		const lines: string[] = [];
		const text = entry.text;
		if (visibleWidth(text) <= maxTextWidth) {
			lines.push(` ${tsStr}  ${theme.fg("dim", theme.italic(text))}`);
		} else {
			// Simple word wrap
			let remaining = text;
			let first = true;
			while (remaining.length > 0) {
				const chunk = remaining.slice(0, maxTextWidth);
				remaining = remaining.slice(maxTextWidth);
				if (first) {
					lines.push(` ${tsStr}  ${theme.fg("dim", theme.italic(chunk))}`);
					first = false;
				} else {
					lines.push(` ${" ".repeat(10)}${theme.fg("dim", theme.italic(chunk))}`);
				}
			}
		}
		return lines;
	}

	if (entry.kind === "tool_start") {
		const verb = toolVerb(entry.toolName);
		return [` ${tsStr}  ${theme.fg("warning", verb)}`];
	}

	if (entry.kind === "tool_end") {
		const dur = entry.durationMs < 1000
			? `${(entry.durationMs / 1000).toFixed(1)}s`
			: `${(entry.durationMs / 1000).toFixed(1)}s`;
		return [` ${tsStr}  ${theme.fg("muted", entry.toolName)} ${theme.fg("dim", "\u2500")} ${theme.fg("dim", dur)}`];
	}

	if (entry.kind === "turn_end") {
		const tokStr = formatTokens(entry.tokens);
		const label = `\u2500\u2500 turn ${String(entry.turnNumber)} complete \u2500\u2500 ${tokStr} tokens \u2500\u2500`;
		return [` ${theme.fg("dim", label)}`];
	}

	return [];
}

// ── Main export ──

export async function openInteractiveWidget(ctx: ExtensionCommandContext, deps: InteractiveWidgetDeps): Promise<void> {
	const style = deps.getStyle();
	const strings = getTeamsStrings(style);
	const names = getVisibleWorkerNames({
		teammates: deps.getTeammates(),
		teamConfig: deps.getTeamConfig(),
		tasks: deps.getTasks(),
	});
	if (names.length === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s to show`, "info");
		return;
	}

	// Hide persistent widget while interactive one is open.
	deps.suppressWidget();

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
				let sessionScrollOffset = 0;
				let sessionAutoFollow = true;

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

				function buildRows(): { rows: Row[]; memberNames: string[] } {
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

					// Workers
					const memberNames = getVisibleWorkerNames({ teammates, teamConfig, tasks });
					for (const name of memberNames) {
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

					return { rows, memberNames };
				}

				// ── Overview render (identical to persistent widget + cursor) ──

				function renderOverview(width: number): string[] {
					const tasks = deps.getTasks();
					const tracker = deps.getTracker();
					const delegateMode = deps.isDelegateMode();
					const { rows, memberNames } = buildRows();

					// Clamp cursor
					if (cursorIndex >= memberNames.length) cursorIndex = Math.max(0, memberNames.length - 1);

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
						for (const name of memberNames) totalTokensRaw += tracker.get(name).totalTokens;
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
							const isSelected = !r.isChairman && memberNames.indexOf(r.name) === cursorIndex;
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
					const transcript = deps.getTranscript(sessionName);

					const lines: string[] = [];
					const sep = theme.fg("dim", "\u2500".repeat(Math.max(0, width - 2)));

					// Header
					const icon = theme.fg(STATUS_COLOR[statusKey], STATUS_ICON[statusKey]);
					const nameStr = theme.bold(theme.fg("accent", formatMemberDisplayName(style, sessionName)));
					const status = theme.fg(STATUS_COLOR[statusKey], statusKey);
					const tokens = theme.fg("dim", `${formatTokens(activity.totalTokens)} tokens`);
					const taskLabel = activeTask
						? ` ${theme.fg("muted", "\u00b7")} ${theme.fg("dim", `#${String(activeTask.id)} ${activeTask.subject}`)}`
						: "";
					lines.push(truncateToWidth(` ${icon} ${nameStr} \u2014 ${status} \u00b7 ${tokens}${taskLabel}`, width));
					lines.push(truncateToWidth(` ${sep}`, width));

					// Format all transcript entries into rendered lines
					const allTranscriptLines: string[] = [];
					for (const entry of transcript.getEntries()) {
						const formatted = formatTranscriptEntry(entry, theme, width);
						for (const fl of formatted) {
							allTranscriptLines.push(truncateToWidth(fl, width));
						}
					}

					const totalLines = allTranscriptLines.length;

					if (totalLines === 0) {
						// Show current activity or waiting message when transcript is empty
						if (activity.currentToolName) {
							lines.push(truncateToWidth(
								` ${theme.fg("warning", toolActivity(activity.currentToolName))}`,
								width,
							));
						} else if (statusKey === "streaming") {
							lines.push(truncateToWidth(` ${theme.fg("dim", theme.italic("thinking\u2026"))}`, width));
						} else {
							lines.push(truncateToWidth(` ${theme.fg("dim", theme.italic("waiting for activity\u2026"))}`, width));
						}
					} else {
						// Determine visible window size based on terminal height
						const termHeight = process.stdout.rows || 24;
						// Reserve: header(2) + scrollBar(1) + notification(0-1) + hintsSep(1) + hints(1)
						const notifLines = notification ? 1 : 0;
						const chromeLines = 2 + 1 + notifLines + 1 + 1;
						const viewportHeight = Math.max(3, termHeight - chromeLines);

						// Apply scroll windowing only if content exceeds viewport
						if (totalLines <= viewportHeight) {
							// Everything fits — just show all lines
							for (const tl of allTranscriptLines) lines.push(tl);
							sessionScrollOffset = 0;
						} else {
							const maxScroll = totalLines - viewportHeight;

							// Clamp
							if (sessionScrollOffset > maxScroll) sessionScrollOffset = maxScroll;
							if (sessionScrollOffset < 0) sessionScrollOffset = 0;
							if (sessionAutoFollow) sessionScrollOffset = 0;

							const endIndex = totalLines - sessionScrollOffset;
							const startIndex = Math.max(0, endIndex - viewportHeight);
							const visible = allTranscriptLines.slice(startIndex, endIndex);
							for (const vl of visible) lines.push(vl);
						}
					}

					// Scroll indicator bar
					if (sessionScrollOffset > 0) {
						lines.push(truncateToWidth(
							` ${theme.fg("accent", `\u2193 ${String(sessionScrollOffset)} more line${sessionScrollOffset === 1 ? "" : "s"} (g to follow)`)}`,
							width,
						));
					} else if (totalLines > 0) {
						lines.push(truncateToWidth(
							` ${theme.fg("success", "\u25cf following")}`,
							width,
						));
					}

					// Notification
					if (notification) {
						lines.push(
							truncateToWidth(" " + theme.fg(notification.color, notification.text), width),
						);
					}

					// Hints
					lines.push(truncateToWidth(` ${sep}`, width));
					lines.push(truncateToWidth(
						theme.fg("dim", " \u2191\u2193 scroll \u00b7 g follow \u00b7 m message \u00b7 a abort \u00b7 k kill \u00b7 esc back"),
						width,
					));

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
							if (matchesKey(data, "up")) {
								sessionScrollOffset += 1;
								sessionAutoFollow = false;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "down")) {
								sessionScrollOffset = Math.max(0, sessionScrollOffset - 1);
								if (sessionScrollOffset === 0) sessionAutoFollow = true;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "pageUp")) {
								const h = process.stdout.rows || 24;
								const jump = Math.max(1, Math.floor(h / 2));
								sessionScrollOffset += jump;
								sessionAutoFollow = false;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "pageDown")) {
								const h = process.stdout.rows || 24;
								const jump = Math.max(1, Math.floor(h / 2));
								sessionScrollOffset = Math.max(0, sessionScrollOffset - jump);
								if (sessionScrollOffset === 0) sessionAutoFollow = true;
								tui.requestRender();
								return;
							}
							if (data === "g" || matchesKey(data, "end")) {
								sessionScrollOffset = 0;
								sessionAutoFollow = true;
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
									deps.abortMember(sessionName);
									showNotification(`Abort sent to ${formatMemberDisplayName(style, sessionName)}`, "warning");
								}
								return;
							}
							if (data === "k") {
								if (sessionName) {
									const name = sessionName;
									deps.killMember(name);
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
						const memberNames = getVisibleWorkerNames({
							teammates: deps.getTeammates(),
							teamConfig: deps.getTeamConfig(),
							tasks: deps.getTasks(),
						});

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
							cursorIndex = Math.min(memberNames.length - 1, cursorIndex + 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "enter")) {
							const name = memberNames[cursorIndex];
							if (name) {
								sessionName = name;
								mode = "session";
								sessionScrollOffset = 0;
								sessionAutoFollow = true;
								tui.requestRender();
							}
							return;
						}
						if (data === "m") {
							const name = memberNames[cursorIndex];
							if (name) {
								dmTarget = name;
								mode = "dm";
								dmBuffer = "";
								tui.requestRender();
							}
							return;
						}
						if (data === "a") {
							const name = memberNames[cursorIndex];
							if (name) {
								deps.abortMember(name);
								showNotification(`Abort sent to ${formatMemberDisplayName(style, name)}`, "warning");
							}
							return;
						}
						if (data === "k") {
							const name = memberNames[cursorIndex];
							if (name) {
								deps.killMember(name);
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
			{},
		);
	} finally {
		deps.restoreWidget();
	}
}
