import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { TeammateRpc, TeammateStatus } from "./teammate-rpc.js";
import type { ActivityTracker } from "./activity-tracker.js";
import type { TeamTask, TaskStatus } from "./task-store.js";
import type { TeamConfig, TeamMember } from "./team-config.js";

export interface WidgetDeps {
	getTeammates(): Map<string, TeammateRpc>;
	getTracker(): ActivityTracker;
	getTasks(): TeamTask[];
	getTeamConfig(): TeamConfig | null;
	isDelegateMode(): boolean;
}

export type WidgetFactory = (tui: TUI, theme: Theme) => Component;

function countTasks(tasks: TeamTask[]): Record<TaskStatus, number> {
	const init: Record<TaskStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
	for (const t of tasks) {
		init[t.status] = (init[t.status] ?? 0) + 1;
	}
	return init;
}

// Status icon and color mapping
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

function padRight(str: string, targetWidth: number): string {
	const w = visibleWidth(str);
	return w >= targetWidth ? str : str + " ".repeat(targetWidth - w);
}

function resolveStatus(rpc: TeammateRpc | undefined, cfg: TeamMember | undefined): TeammateStatus {
	if (rpc) return rpc.status;
	return cfg?.status === "online" ? "idle" : "stopped";
}

export function createTeamsWidget(deps: WidgetDeps): WidgetFactory {
	return (_tui: TUI, theme: Theme): Component => {
		return {
			render(width: number): string[] {
				const teammates = deps.getTeammates();
				const tracker = deps.getTracker();
				const tasks = deps.getTasks();
				const teamConfig = deps.getTeamConfig();
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
				const c = countTasks(tasks);
				let header = " " + theme.bold(theme.fg("accent", "Teams"));
				if (delegateMode) header += " " + theme.fg("warning", "[delegate]");

				const counts: string[] = [];
				if (c.pending > 0) counts.push(theme.fg("muted", `pending:${String(c.pending)}`));
				if (c.in_progress > 0) counts.push(theme.fg("warning", `active:${String(c.in_progress)}`));
				if (c.completed > 0) counts.push(theme.fg("success", `done:${String(c.completed)}`));
				const countStr = counts.length > 0 ? "  " + counts.join("  ") : "";

				// Right-align counts
				const headerLeft = header;
				const headerLeftW = visibleWidth(headerLeft);
				const countStrW = visibleWidth(countStr);
				const gap = Math.max(1, width - headerLeftW - countStrW - 1);
				const headerLine = headerLeft + " ".repeat(gap) + countStr;

				lines.push(truncateToWidth(headerLine, width));

				// ── Teammate rows ──
				const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
				const cfgByName = new Map<string, TeamMember>();
				for (const m of cfgWorkers) cfgByName.set(m.name, m);

				const visibleNames = new Set<string>();
				for (const name of teammates.keys()) visibleNames.add(name);
				for (const m of cfgWorkers) {
					if (m.status === "online") visibleNames.add(m.name);
				}
				for (const t of tasks) {
					if (t.owner && t.status === "in_progress") visibleNames.add(t.owner);
				}

				if (visibleNames.size === 0) {
					lines.push(
						truncateToWidth(" " + theme.fg("dim", "(no comrades)  /team spawn <name>"), width),
					);
				} else {
					const sortedNames = Array.from(visibleNames).sort();
					const nameColWidth = Math.max(...sortedNames.map((n) => visibleWidth(`Comrade ${n}`)));

					for (const name of sortedNames) {
						const rpc = teammates.get(name);
						const cfg = cfgByName.get(name);
						const activity = tracker.get(name);

						const active = tasks.find((x) => x.owner === name && x.status === "in_progress");
						const statusKey = resolveStatus(rpc, cfg);

						const icon = theme.fg(STATUS_COLOR[statusKey], STATUS_ICON[statusKey]);
						const displayName = `Comrade ${name}`;
						const styledName = theme.bold(displayName);
						const statusLabel = theme.fg(STATUS_COLOR[statusKey], padRight(statusKey, 9));
						const taskTag = active ? " " + theme.fg("muted", `task:#${String(active.id)}`) : "";
						const toolLabel = activity.currentToolName
							? "  " + theme.fg("warning", activity.currentToolName)
							: "";
						const toolCount =
							activity.toolUseCount > 0 ? "  " + theme.fg("dim", `(${String(activity.toolUseCount)} tools)`) : "";

						const row = ` ${icon} ${padRight(styledName, nameColWidth)} ${statusLabel}${taskTag}${toolLabel}${toolCount}`;
						lines.push(truncateToWidth(row, width));
					}
				}

				// ── Hints line ──
				const hints = theme.fg(
					"dim",
					" /team panel \u00b7 /team dm <name> <msg> \u00b7 /team task list",
				);
				lines.push(truncateToWidth(hints, width));

				return lines;
			},
			invalidate() {},
		};
	};
}
