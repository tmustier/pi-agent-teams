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
	setTaskStatus(taskId: string, status: TeamTask["status"]): Promise<boolean>;
	unassignTask(taskId: string): Promise<boolean>;
	assignTask(taskId: string, ownerName: string): Promise<boolean>;
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

type WidgetMode = "overview" | "session" | "dm" | "tasks" | "reassign";

// ── Transcript formatting ──

function summarizeTranscriptEntry(entry: TranscriptEntry | undefined): string | null {
	if (!entry) return null;
	if (entry.kind === "text") {
		const compact = entry.text.replace(/\s+/g, " ").trim();
		if (!compact) return null;
		return compact.length > 96 ? `${compact.slice(0, 95)}…` : compact;
	}
	if (entry.kind === "tool_start") return `running ${entry.toolName}`;
	if (entry.kind === "tool_end") return `finished ${entry.toolName} (${(entry.durationMs / 1000).toFixed(1)}s)`;
	const tok = formatTokens(entry.tokens);
	return `turn ${String(entry.turnNumber)} complete (${tok} tokens)`;
}

function taskStatusRank(status: TeamTask["status"]): number {
	if (status === "in_progress") return 0;
	if (status === "pending") return 1;
	return 2;
}

function parseTaskId(taskId: string): number {
	const parsed = Number.parseInt(taskId, 10);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function unresolvedDependencies(task: TeamTask, taskById: ReadonlyMap<string, TeamTask>): string[] {
	const unresolved: string[] = [];
	for (const depId of task.blockedBy) {
		const dep = taskById.get(depId);
		if (!dep || dep.status !== "completed") unresolved.push(depId);
	}
	return unresolved;
}

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
				let dmReturnMode: Exclude<WidgetMode, "dm"> = "overview";
				let notification: { text: string; color: ThemeColor } | null = null;
				let notificationTimer: ReturnType<typeof setTimeout> | null = null;
				let sessionScrollOffset = 0;
				let sessionAutoFollow = true;
				let taskViewOwner: string | null = null;
				let taskCursorIndex = 0;
				let taskReturnMode: "overview" | "session" = "overview";
				let reassignTaskId: string | null = null;
				let reassignCursorIndex = 0;

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

				function openTaskView(ownerName: string, from: "overview" | "session") {
					taskViewOwner = ownerName;
					taskCursorIndex = 0;
					taskReturnMode = from;
					mode = "tasks";
					tui.requestRender();
				}

				function getOwnedTasks(ownerName: string): TeamTask[] {
					return deps
						.getTasks()
						.filter((task) => task.owner === ownerName)
						.sort((a, b) => {
							const rank = taskStatusRank(a.status) - taskStatusRank(b.status);
							if (rank !== 0) return rank;
							return parseTaskId(a.id) - parseTaskId(b.id);
						});
				}

				function getSelectedOwnedTask(ownerName: string): TeamTask | null {
					const owned = getOwnedTasks(ownerName);
					if (owned.length === 0) return null;
					const clamped = Math.max(0, Math.min(taskCursorIndex, owned.length - 1));
					taskCursorIndex = clamped;
					return owned[clamped] ?? null;
				}

				function getReassignableMembers(): string[] {
					return getVisibleWorkerNames({
						teammates: deps.getTeammates(),
						teamConfig: deps.getTeamConfig(),
						tasks: deps.getTasks(),
					});
				}

				function openReassign(taskId: string, currentOwner: string) {
					const members = getReassignableMembers();
					if (members.length === 0) {
						showNotification(`No ${strings.memberTitle.toLowerCase()}s available`, "error");
						return;
					}
					reassignTaskId = taskId;
					reassignCursorIndex = Math.max(0, members.indexOf(currentOwner));
					mode = "reassign";
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

					// Leader control
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

					const selectedName = memberNames[cursorIndex];
					if (selectedName) {
						const selectedLabel = formatMemberDisplayName(style, selectedName);
						const owned = tasks.filter((t) => t.owner === selectedName);
						const activeTask = owned.find((t) => t.status === "in_progress");
						const latestCompleted = owned
							.filter((t) => t.status === "completed")
							.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
							.at(0);
						const entries = deps.getTranscript(selectedName).getEntries();
						const lastSummary = summarizeTranscriptEntry(entries.at(-1));

						lines.push(truncateToWidth(` ${theme.fg("muted", "selected:")} ${theme.bold(theme.fg("accent", selectedLabel))}`, width));
						if (activeTask) {
							lines.push(
								truncateToWidth(
									` ${theme.fg("dim", "active:")} ${theme.fg("warning", `#${String(activeTask.id)} ${activeTask.subject}`)}`,
									width,
								),
							);
						} else if (latestCompleted) {
							lines.push(
								truncateToWidth(
									` ${theme.fg("dim", "last done:")} ${theme.fg("success", `#${String(latestCompleted.id)} ${latestCompleted.subject}`)}`,
									width,
								),
							);
						}
						if (lastSummary) {
							lines.push(truncateToWidth(` ${theme.fg("dim", "last event:")} ${theme.fg("muted", lastSummary)}`, width));
						}
					}

					// Notification
					if (notification) {
						lines.push(truncateToWidth(" " + theme.fg(notification.color, notification.text), width));
					}

					// Hints
					const hints = theme.fg(
						"dim",
						" \u2191\u2193/ws select \u00b7 1-9 jump \u00b7 enter view \u00b7 t tasks \u00b7 m/d message \u00b7 a abort \u00b7 k kill \u00b7 esc close",
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
						theme.fg("dim", " \u2191\u2193/ws scroll \u00b7 g follow \u00b7 t tasks \u00b7 m/d message \u00b7 a abort \u00b7 k kill \u00b7 esc back"),
						width,
					));

					return lines;
				}

				// ── Task list render ──

				function renderTasks(width: number): string[] {
					if (!taskViewOwner) return renderOverview(width);

					const ownerName = taskViewOwner;
					const ownerLabel = formatMemberDisplayName(style, ownerName);
					const allTasks = deps.getTasks();
					const taskById = new Map<string, TeamTask>();
					for (const task of allTasks) taskById.set(task.id, task);

					const ownerTasks = getOwnedTasks(ownerName);

					if (taskCursorIndex >= ownerTasks.length) taskCursorIndex = Math.max(0, ownerTasks.length - 1);

					const pendingCount = ownerTasks.filter((t) => t.status === "pending").length;
					const inProgressCount = ownerTasks.filter((t) => t.status === "in_progress").length;
					const completedCount = ownerTasks.filter((t) => t.status === "completed").length;
					const blockedCount = ownerTasks.filter((t) => t.status === "pending" && unresolvedDependencies(t, taskById).length > 0).length;

					const lines: string[] = [];
					const sep = theme.fg("dim", "─".repeat(Math.max(0, width - 2)));
					const returnLabel = taskReturnMode === "session" ? "esc back to transcript" : "esc back";

					lines.push(truncateToWidth(` ${theme.bold(theme.fg("accent", `Tasks · ${ownerLabel}`))}`, width));
					lines.push(
						truncateToWidth(
							` ${theme.fg("dim", `${inProgressCount} in progress · ${pendingCount} pending · ${blockedCount} blocked · ${completedCount} done`)}`,
							width,
						),
					);

					if (ownerTasks.length === 0) {
						lines.push(truncateToWidth(` ${theme.fg("dim", theme.italic("no tasks assigned"))}`, width));
						if (notification) lines.push(truncateToWidth(` ${theme.fg(notification.color, notification.text)}`, width));
						lines.push(truncateToWidth(` ${sep}`, width));
						lines.push(
							truncateToWidth(
								theme.fg("dim", ` ${returnLabel} · m/d message · a abort · k kill · enter open transcript`),
								width,
							),
						);
						return lines;
					}

					const termHeight = process.stdout.rows || 24;
					const notifLines = notification ? 1 : 0;
					const detailLines = 4;
					const chromeLines = 2 + detailLines + notifLines + 1 + 1;
					const viewportHeight = Math.max(3, termHeight - chromeLines);

					let start = 0;
					if (ownerTasks.length > viewportHeight) {
						const ideal = taskCursorIndex - Math.floor(viewportHeight / 2);
						const maxStart = ownerTasks.length - viewportHeight;
						start = Math.max(0, Math.min(maxStart, ideal));
					}
					const end = Math.min(ownerTasks.length, start + viewportHeight);

					for (let idx = start; idx < end; idx++) {
						const task = ownerTasks[idx];
						if (!task) continue;
						const unresolved = unresolvedDependencies(task, taskById);
						const isBlocked = task.status === "pending" && unresolved.length > 0;
						const statusLabel = isBlocked ? "blocked" : task.status;
						const statusColor: ThemeColor = statusLabel === "in_progress"
							? "warning"
							: statusLabel === "completed"
								? "success"
								: statusLabel === "blocked"
									? "error"
									: "muted";
						const selected = idx === taskCursorIndex;
						const pointer = selected ? theme.fg("accent", "▸") : " ";
						const subject = task.subject.length > 58 ? `${task.subject.slice(0, 57)}…` : task.subject;
						const depTag = unresolved.length > 0 ? ` deps:${String(unresolved.length)}` : "";
						const row = `${pointer}${theme.fg(statusColor, statusLabel.padEnd(11))} ${theme.fg("dim", `#${task.id}`)} ${subject}${theme.fg("dim", depTag)}`;
						lines.push(truncateToWidth(row, width));
					}

					const selectedTask = ownerTasks[taskCursorIndex];
					if (selectedTask) {
						const unresolved = unresolvedDependencies(selectedTask, taskById);
						const depSummary = selectedTask.blockedBy.length === 0
							? "none"
							: selectedTask.blockedBy
								.map((depId) => {
									const dep = taskById.get(depId);
									if (!dep) return `#${depId}?`;
									return dep.status === "completed" ? `#${depId}:done` : `#${depId}:open`;
								})
								.join(", ");
						const blockSummary = selectedTask.blocks.length === 0
							? "none"
							: selectedTask.blocks.map((id) => `#${id}`).join(", ");
						const desc = selectedTask.description.replace(/\s+/g, " ").trim();
						const descPreview = desc.length > 90 ? `${desc.slice(0, 89)}…` : desc || "(no description)";

						lines.push(truncateToWidth(` ${sep}`, width));
						lines.push(
							truncateToWidth(
								` ${theme.fg("muted", "selected:")} ${theme.bold(`#${selectedTask.id} ${selectedTask.subject}`)}`,
								width,
							),
						);
						lines.push(
							truncateToWidth(
								` ${theme.fg("dim", "depends on:")} ${theme.fg(unresolved.length > 0 ? "error" : "muted", depSummary)}`,
								width,
							),
						);
						lines.push(truncateToWidth(` ${theme.fg("dim", "blocking:")} ${theme.fg("muted", blockSummary)}`, width));
						lines.push(truncateToWidth(` ${theme.fg("dim", "desc:")} ${theme.fg("muted", descPreview)}`, width));
					}

					if (notification) lines.push(truncateToWidth(` ${theme.fg(notification.color, notification.text)}`, width));
					lines.push(truncateToWidth(` ${sep}`, width));
					lines.push(
						truncateToWidth(
							theme.fg("dim", ` ↑↓/ws select · enter transcript · c complete · p pending · i in-progress · u unassign · r reassign · m/d message · ${returnLabel}`),
							width,
						),
					);

					return lines;
				}

				// ── Reassign render ──

				function renderReassign(width: number): string[] {
					if (!reassignTaskId) return renderTasks(width);
					const members = getReassignableMembers();
					const task = deps.getTasks().find((t) => t.id === reassignTaskId);

					const lines: string[] = [];
					const sep = theme.fg("dim", "─".repeat(Math.max(0, width - 2)));

					if (!task) {
						lines.push(truncateToWidth(` ${theme.fg("error", `Task #${reassignTaskId} not found`)}`, width));
						lines.push(truncateToWidth(` ${sep}`, width));
						lines.push(truncateToWidth(theme.fg("dim", " esc back"), width));
						return lines;
					}

					lines.push(truncateToWidth(` ${theme.bold(theme.fg("accent", `Reassign #${task.id}`))}`, width));
					lines.push(truncateToWidth(` ${theme.fg("dim", task.subject)}`, width));
					const ownerLabel = task.owner ? formatMemberDisplayName(style, task.owner) : "(unassigned)";
					lines.push(truncateToWidth(` ${theme.fg("muted", `current owner: ${ownerLabel}`)}`, width));

					if (members.length === 0) {
						lines.push(truncateToWidth(` ${theme.fg("error", `No ${strings.memberTitle.toLowerCase()}s available`)}`, width));
						lines.push(truncateToWidth(` ${sep}`, width));
						lines.push(truncateToWidth(theme.fg("dim", " esc back"), width));
						return lines;
					}

					reassignCursorIndex = Math.max(0, Math.min(reassignCursorIndex, members.length - 1));
					for (let i = 0; i < members.length; i++) {
						const name = members[i];
						if (!name) continue;
						const selected = i === reassignCursorIndex;
						const pointer = selected ? theme.fg("accent", "▸") : " ";
						const display = formatMemberDisplayName(style, name);
						const current = task.owner === name ? theme.fg("dim", " (current)") : "";
						lines.push(truncateToWidth(`${pointer}${theme.bold(display)}${current}`, width));
					}

					if (notification) lines.push(truncateToWidth(` ${theme.fg(notification.color, notification.text)}`, width));
					lines.push(truncateToWidth(` ${sep}`, width));
					lines.push(
						truncateToWidth(
							theme.fg("dim", " ↑↓/ws select · 1-9 jump · enter assign · esc cancel"),
							width,
						),
					);

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
							case "tasks":
								return renderTasks(width);
							case "reassign":
								return renderReassign(width);
						}
					},

					handleInput(data: string): void {
						// ── DM mode ──
						if (mode === "dm") {
							if (matchesKey(data, "escape")) {
								mode = dmReturnMode;
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
									mode = dmReturnMode;
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

						// ── Reassign mode ──
						if (mode === "reassign") {
							if (matchesKey(data, "escape")) {
								mode = "tasks";
								reassignTaskId = null;
								tui.requestRender();
								return;
							}
							const members = getReassignableMembers();
							if (members.length === 0 || !reassignTaskId) {
								mode = "tasks";
								reassignTaskId = null;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "up") || data === "w") {
								reassignCursorIndex = Math.max(0, reassignCursorIndex - 1);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "down") || data === "s") {
								reassignCursorIndex = Math.min(members.length - 1, reassignCursorIndex + 1);
								tui.requestRender();
								return;
							}
							if (/^[1-9]$/.test(data)) {
								const jump = Number.parseInt(data, 10) - 1;
								if (jump < members.length) {
									reassignCursorIndex = jump;
									tui.requestRender();
								}
								return;
							}
							if (matchesKey(data, "enter")) {
								const taskId = reassignTaskId;
								const targetName = members[reassignCursorIndex];
								if (!taskId || !targetName) return;
								const oldOwner = taskViewOwner;
								mode = "tasks";
								reassignTaskId = null;
								void deps.assignTask(taskId, targetName)
									.then((ok) => {
										if (ok) {
											taskViewOwner = targetName;
											taskCursorIndex = 0;
											showNotification(`Reassigned task #${taskId} to ${formatMemberDisplayName(style, targetName)}`);
										} else {
											taskViewOwner = oldOwner;
											showNotification(`Failed to reassign task #${taskId}`, "error");
										}
										tui.requestRender();
									})
									.catch(() => {
										taskViewOwner = oldOwner;
										showNotification(`Failed to reassign task #${taskId}`, "error");
										tui.requestRender();
									});
								tui.requestRender();
								return;
							}
							return;
						}

						// ── Tasks mode ──
						if (mode === "tasks") {
							if (matchesKey(data, "escape") || data === "t") {
								mode = taskReturnMode;
								taskViewOwner = null;
								tui.requestRender();
								return;
							}
							if (!taskViewOwner) {
								mode = "overview";
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "up") || data === "w") {
								taskCursorIndex = Math.max(0, taskCursorIndex - 1);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "down") || data === "s") {
								const ownedCount = getOwnedTasks(taskViewOwner).length;
								taskCursorIndex = Math.min(Math.max(0, ownedCount - 1), taskCursorIndex + 1);
								tui.requestRender();
								return;
							}
							if (data === "c" || data === "p" || data === "i" || data === "u" || data === "r") {
								const selected = getSelectedOwnedTask(taskViewOwner);
								if (!selected) {
									showNotification("No task selected", "error");
									return;
								}

								if (data === "r") {
									openReassign(selected.id, taskViewOwner);
									return;
								}

								if (data === "u") {
									const taskId = selected.id;
									void deps.unassignTask(taskId)
										.then((ok) => {
											if (ok) showNotification(`Unassigned task #${taskId}`);
											else showNotification(`Failed to unassign task #${taskId}`, "error");
										})
										.catch(() => showNotification(`Failed to unassign task #${taskId}`, "error"));
									return;
								}

								const targetStatus: TeamTask["status"] = data === "c"
									? "completed"
									: data === "i"
										? "in_progress"
										: "pending";
								if (selected.status === targetStatus) {
									showNotification(`Task #${selected.id} already ${targetStatus}`, "muted");
									return;
								}
								const taskId = selected.id;
								void deps.setTaskStatus(taskId, targetStatus)
									.then((ok) => {
										if (ok) showNotification(`Task #${taskId} set to ${targetStatus}`);
										else showNotification(`Failed to update task #${taskId}`, "error");
									})
									.catch(() => showNotification(`Failed to update task #${taskId}`, "error"));
								return;
							}
							if (matchesKey(data, "enter") || data === "o") {
								sessionName = taskViewOwner;
								mode = "session";
								sessionScrollOffset = 0;
								sessionAutoFollow = true;
								taskViewOwner = null;
								tui.requestRender();
								return;
							}
							if (data === "m" || data === "d") {
								dmTarget = taskViewOwner;
								dmReturnMode = "tasks";
								mode = "dm";
								dmBuffer = "";
								tui.requestRender();
								return;
							}
							if (data === "a") {
								deps.abortMember(taskViewOwner);
								showNotification(`${formatMemberDisplayName(style, taskViewOwner)} ${strings.abortRequestedVerb}`, "warning");
								return;
							}
							if (data === "k") {
								const target = taskViewOwner;
								deps.killMember(target);
								showNotification(`${formatMemberDisplayName(style, target)} ${strings.killedVerb} (SIGTERM)`, "warning");
								if (sessionName === target) {
									sessionName = null;
									taskReturnMode = "overview";
								}
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
							if (matchesKey(data, "up") || data === "w") {
								sessionScrollOffset += 1;
								sessionAutoFollow = false;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "down") || data === "s") {
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
							if (data === "t" && sessionName) {
								openTaskView(sessionName, "session");
								return;
							}
							if (data === "m" || data === "d") {
								dmTarget = sessionName;
								dmReturnMode = "session";
								mode = "dm";
								dmBuffer = "";
								tui.requestRender();
								return;
							}
							if (data === "a") {
								if (sessionName) {
									deps.abortMember(sessionName);
									showNotification(`${formatMemberDisplayName(style, sessionName)} ${strings.abortRequestedVerb}`, "warning");
								}
								return;
							}
							if (data === "k") {
								if (sessionName) {
									const name = sessionName;
									deps.killMember(name);
									showNotification(`${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)`, "warning");
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
						if (matchesKey(data, "up") || data === "w") {
							cursorIndex = Math.max(0, cursorIndex - 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "down") || data === "s") {
							cursorIndex = Math.min(memberNames.length - 1, cursorIndex + 1);
							tui.requestRender();
							return;
						}
						if (/^[1-9]$/.test(data)) {
							const jump = Number.parseInt(data, 10) - 1;
							if (jump < memberNames.length) {
								cursorIndex = jump;
								tui.requestRender();
							}
							return;
						}
						if (data === "t") {
							const name = memberNames[cursorIndex];
							if (name) openTaskView(name, "overview");
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
						if (data === "m" || data === "d") {
							const name = memberNames[cursorIndex];
							if (name) {
								dmTarget = name;
								dmReturnMode = "overview";
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
								showNotification(`${formatMemberDisplayName(style, name)} ${strings.abortRequestedVerb}`, "warning");
							}
							return;
						}
						if (data === "k") {
							const name = memberNames[cursorIndex];
							if (name) {
								deps.killMember(name);
								showNotification(`${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)`, "warning");
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
