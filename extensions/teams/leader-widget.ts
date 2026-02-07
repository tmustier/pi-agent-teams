import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamTask, TaskStatus } from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";

function countTasks(tasks: TeamTask[]): Record<TaskStatus, number> {
	return tasks.reduce(
		(acc, t) => {
			acc[t.status] = (acc[t.status] ?? 0) + 1;
			return acc;
		},
		{ pending: 0, in_progress: 0, completed: 0 } as Record<TaskStatus, number>,
	);
}

export function buildTeamsWidgetLines(opts: {
	delegateMode: boolean;
	tasks: TeamTask[];
	teammates: Map<string, TeammateRpc>;
	teamConfig: TeamConfig | null;
}): string[] {
	const { delegateMode, tasks, teammates, teamConfig } = opts;

	// Hide the widget entirely when there is no active team state.
	const hasOnlineMembers = (teamConfig?.members ?? []).some((m) => m.role === "worker" && m.status === "online");
	if (teammates.size === 0 && tasks.length === 0 && !hasOnlineMembers) {
		return [];
	}

	const lines: string[] = [];
	lines.push(delegateMode ? "Teams [delegate]" : "Teams");

	const c = countTasks(tasks);
	lines.push(`  Tasks: pending ${c.pending} • in_progress ${c.in_progress} • completed ${c.completed}`);

	const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
	const cfgByName = new Map<string, TeamMember>();
	for (const m of cfgWorkers) cfgByName.set(m.name, m);

	const visibleNames = new Set<string>();
	for (const name of teammates.keys()) visibleNames.add(name);
	for (const m of cfgWorkers) {
		if (m.status === "online") visibleNames.add(m.name);
	}
	// Fallback: show active task owners even if they haven't been persisted in config yet.
	for (const t of tasks) {
		if (t.owner && t.status === "in_progress") visibleNames.add(t.owner);
	}

	if (visibleNames.size === 0) {
		lines.push("  (no teammates)  •  /team spawn <name> [fresh|branch] [shared|worktree]");
		lines.push("  /team task add <text...>  •  /team task list");
		return lines;
	}

	for (const name of Array.from(visibleNames).sort()) {
		const rpc = teammates.get(name);
		const cfg = cfgByName.get(name);

		const active = tasks.find((x) => x.owner === name && x.status === "in_progress");
		const taskTag = active ? `task:${active.id}` : "";

		if (rpc) {
			const status = rpc.status.padEnd(9);
			const tail = rpc.lastAssistantText.trim().split("\n").slice(-1)[0];
			lines.push(
				`  ${name}: ${status} ${taskTag ? "• " + taskTag + " " : ""}${tail ? "• " + tail.slice(0, 60) : ""}`,
			);
		} else {
			const status = (cfg?.status ?? "offline").padEnd(9);
			const seen = cfg?.lastSeenAt ? `• seen ${cfg.lastSeenAt.slice(11, 19)}` : "";
			lines.push(`  ${name}: ${status} ${taskTag ? "• " + taskTag : ""} ${seen}`.trimEnd());
		}
	}

	lines.push("  /team dm <name> <msg...>  •  /team broadcast <msg...>");
	if (teammates.size > 0) lines.push("  /team send <name> <msg...>  •  /team kill <name>");
	lines.push("  /team task add <text...>  •  /team task list");

	return lines;
}
