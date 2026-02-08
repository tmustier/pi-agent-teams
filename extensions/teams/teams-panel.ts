import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker, TeammateActivity } from "./activity-tracker.js";
import type { TeamTask } from "./task-store.js";
import type { TeamConfig, TeamMember } from "./team-config.js";

export interface PanelDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
}

// Status icon + color mapping (mirrors teams-widget)
const STATUS_ICON: Record<TeammateStatus, string> = {
	streaming: "◉",
	idle: "●",
	starting: "○",
	stopped: "✗",
	error: "✗",
};

const STATUS_COLOR: Record<TeammateStatus, ThemeColor> = {
	streaming: "accent",
	idle: "success",
	starting: "muted",
	stopped: "dim",
	error: "error",
};

function resolveStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): TeammateStatus {
	if (rpc) return rpc.status;
	return cfg?.status === "online" ? "idle" : "stopped";
}

function padRight(str: string, targetWidth: number): string {
	const w = visibleWidth(str);
	return w >= targetWidth ? str : str + " ".repeat(targetWidth - w);
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export async function openTeamsPanel(ctx: ExtensionCommandContext, deps: PanelDeps): Promise<void> {
	const names = getVisibleNames(deps);
	if (names.length === 0) {
		ctx.ui.notify("No comrades to show", "info");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			let selectedIndex = 0;
			let detailExpanded = false;

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const innerW = Math.max(20, width - 4);

					// ── Header ──
					const title = theme.bold(theme.fg("accent", " Teams Panel "));
					const topBorder = theme.fg("border", "┌" + "─".repeat(innerW + 2) + "┐");
					lines.push(topBorder);
					lines.push(theme.fg("border", "│") + " " + padRight(title, innerW) + " " + theme.fg("border", "│"));
					lines.push(theme.fg("border", "├" + "─".repeat(innerW + 2) + "┤"));

					// ── Teammate list ──
					const currentNames = getVisibleNames(deps);
					if (selectedIndex >= currentNames.length) selectedIndex = Math.max(0, currentNames.length - 1);

					for (let i = 0; i < currentNames.length; i++) {
						const name = currentNames[i];
						if (name === undefined) continue;

						const rpc = deps.getTeammates().get(name);
						const cfg = getCfgMember(deps, name);
						const activity = deps.getTracker().get(name);
						const active = deps.getTasks().find((x: TeamTask) => x.owner === name && x.status === "in_progress");
						const statusKey = resolveStatus(rpc, cfg);

						const displayName = `Comrade ${name}`;
						const selected = i === selectedIndex;
						const pointer = selected ? theme.fg("accent", "▸") : " ";
						const icon = theme.fg(STATUS_COLOR[statusKey], STATUS_ICON[statusKey]);
						const styledName = selected ? theme.bold(theme.fg("accent", displayName)) : theme.bold(displayName);
						const statusLabel = theme.fg(STATUS_COLOR[statusKey], statusKey);
						const taskTag = active ? theme.fg("muted", ` task:#${String(active.id)}`) : "";
						const toolLabel = activity.currentToolName ? " " + theme.fg("warning", activity.currentToolName) : "";
						const toolCount =
							activity.toolUseCount > 0 ? " " + theme.fg("dim", `(${String(activity.toolUseCount)})`) : "";

						const row = ` ${pointer} ${icon} ${padRight(styledName, 20)} ${statusLabel}${taskTag}${toolLabel}${toolCount}`;
						lines.push(
							theme.fg("border", "│") +
							truncateToWidth(padRight(row, innerW + 2), innerW + 2) +
							theme.fg("border", "│"),
						);

						// ── Detail view for selected ──
						if (selected && detailExpanded) {
							const detailLines = renderDetail(theme, rpc, activity, active, innerW);
							for (const dl of detailLines) {
								lines.push(
									theme.fg("border", "│") +
									truncateToWidth(padRight(dl, innerW + 2), innerW + 2) +
									theme.fg("border", "│"),
								);
							}
						}
					}

					// ── Footer ──
					lines.push(theme.fg("border", "├" + "─".repeat(innerW + 2) + "┤"));
					const hints = theme.fg("dim", " ↑/↓ navigate · enter toggle detail · esc close");
					lines.push(
						theme.fg("border", "│") +
						truncateToWidth(padRight(hints, innerW + 2), innerW + 2) +
						theme.fg("border", "│"),
					);
					lines.push(theme.fg("border", "└" + "─".repeat(innerW + 2) + "┘"));

					return lines;
				},

				invalidate() {},

				handleInput(data: string) {
					const currentNames = getVisibleNames(deps);
					if (matchesKey(data, "escape") || data === "q") {
						done(undefined);
						return;
					}
					if (matchesKey(data, "up")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
						detailExpanded = false;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						selectedIndex = Math.min(currentNames.length - 1, selectedIndex + 1);
						detailExpanded = false;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						detailExpanded = !detailExpanded;
						tui.requestRender();
						return;
					}
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } },
	);
}

function getVisibleNames(deps: PanelDeps): string[] {
	const teamConfig = deps.getTeamConfig();
	const teammates = deps.getTeammates();
	const tasks = deps.getTasks();
	const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
	const visible = new Set<string>();
	for (const name of teammates.keys()) visible.add(name);
	for (const m of cfgWorkers) {
		if (m.status === "online") visible.add(m.name);
	}
	for (const t of tasks) {
		if (t.owner && t.status === "in_progress") visible.add(t.owner);
	}
	return Array.from(visible).sort();
}

function getCfgMember(deps: PanelDeps, name: string): TeamMember | undefined {
	return (deps.getTeamConfig()?.members ?? []).find((m) => m.name === name);
}

function renderDetail(
	theme: Theme,
	rpc: TeammateRpc | undefined,
	activity: TeammateActivity,
	activeTask: TeamTask | undefined,
	_innerW: number,
): string[] {
	const lines: string[] = [];
	const indent = "      ";

	if (activeTask) {
		lines.push(indent + theme.fg("muted", "task: ") + `#${String(activeTask.id)} ${activeTask.subject}`);
	}

	if (activity.currentToolName) {
		lines.push(indent + theme.fg("muted", "tool: ") + theme.fg("warning", activity.currentToolName));
	} else if (activity.lastToolName) {
		lines.push(indent + theme.fg("muted", "last: ") + theme.fg("dim", activity.lastToolName));
	}

	lines.push(
		indent +
			theme.fg("muted", "stats: ") +
			theme.fg("dim", `${String(activity.toolUseCount)} tools, ${String(activity.turnCount)} turns`),
	);

	// Recent events (last 5)
	const recent = activity.recentEvents.slice(-5);
	if (recent.length > 0) {
		lines.push(indent + theme.fg("muted", "recent:"));
		for (const ev of recent) {
			const ts = formatTimestamp(ev.timestamp);
			const tool = ev.toolName ? ` ${ev.toolName}` : "";
			lines.push(indent + "  " + theme.fg("dim", `${ts} ${ev.type}${tool}`));
		}
	}

	// Last assistant text snippet
	if (rpc && rpc.lastAssistantText.trim()) {
		const lastLine = rpc.lastAssistantText.trim().split("\n").at(-1) ?? "";
		const snippet = lastLine.slice(0, 80);
		lines.push(indent + theme.fg("muted", "text: ") + theme.fg("dim", theme.italic(snippet)));
	}

	return lines;
}
