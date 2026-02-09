import * as path from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import {
	addTaskDependency,
	clearTasks,
	createTask,
	formatTaskLine,
	getTask,
	isTaskBlocked,
	removeTaskDependency,
	updateTask,
	type TeamTask,
} from "./task-store.js";
import { ensureTeamConfig } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName } from "./teams-style.js";

export async function handleTeamTaskCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	leadName: string;
	style: TeamsStyle;
	getTaskListId: () => string | null;
	setTaskListId: (id: string) => void;
	getTasks: () => TeamTask[];
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	parseAssigneePrefix: (text: string) => { assignee?: string; text: string };
	taskAssignmentPayload: (task: TeamTask, assignedBy: string) => unknown;
}): Promise<void> {
	const {
		ctx,
		rest,
		leadName,
		style,
		getTaskListId,
		setTaskListId,
		getTasks,
		refreshTasks,
		renderWidget,
		parseAssigneePrefix,
		taskAssignmentPayload,
	} = opts;

	const [taskSub, ...taskRest] = rest;
	const teamId = ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const effectiveTlId = getTaskListId() ?? teamId;

	if (!taskSub || taskSub === "help") {
		ctx.ui.notify(
			[
				"Usage:",
				"  /team task add <text...>",
				"  /team task assign <id> <agent>",
				"  /team task unassign <id>",
				"  /team task list",
				"  /team task clear [completed|all] [--force]",
				"  /team task show <id>",
				"  /team task dep add <id> <depId>",
				"  /team task dep rm <id> <depId>",
				"  /team task dep ls <id>",
				"  /team task use <taskListId>",
				"Tip: prefix with assignee, e.g. 'alice: review the API surface'",
			].join("\n"),
			"info",
		);
		return;
	}

	switch (taskSub) {
		case "add": {
			const raw = taskRest.join(" ").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /team task add <text...>", "error");
				return;
			}

			const parsed = parseAssigneePrefix(raw);
			const owner = parsed.assignee ? sanitizeName(parsed.assignee) : undefined;
			const description = parsed.text.trim();
			const firstLine = description.split("\n").at(0) ?? "";
			const subject = firstLine.slice(0, 120);

			const task = await createTask(teamDir, effectiveTlId, { subject, description, owner });

			if (owner) {
				const payload = taskAssignmentPayload(task, leadName);
				await writeToMailbox(teamDir, effectiveTlId, owner, {
					from: leadName,
					text: JSON.stringify(payload),
					timestamp: new Date().toISOString(),
				});
			}

			ctx.ui.notify(
				`Created task #${task.id}${owner ? ` (assigned to ${formatMemberDisplayName(style, owner)})` : ""}`,
				"info",
			);
			await refreshTasks();
			renderWidget();
			return;
		}

		case "assign": {
			const taskId = taskRest[0];
			const agent = taskRest[1];
			if (!taskId || !agent) {
				ctx.ui.notify("Usage: /team task assign <id> <agent>", "error");
				return;
			}

			const owner = sanitizeName(agent);
			const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
				if (cur.status !== "completed") {
					return { ...cur, owner, status: "pending" };
				}
				return { ...cur, owner };
			});
			if (!updated) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}

			await writeToMailbox(teamDir, effectiveTlId, owner, {
				from: leadName,
				text: JSON.stringify(taskAssignmentPayload(updated, leadName)),
				timestamp: new Date().toISOString(),
			});

			ctx.ui.notify(`Assigned task #${updated.id} to ${formatMemberDisplayName(style, owner)}`, "info");
			await refreshTasks();
			renderWidget();
			return;
		}

		case "unassign": {
			const taskId = taskRest[0];
			if (!taskId) {
				ctx.ui.notify("Usage: /team task unassign <id>", "error");
				return;
			}

			const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
				if (cur.status !== "completed") {
					return { ...cur, owner: undefined, status: "pending" };
				}
				return { ...cur, owner: undefined };
			});
			if (!updated) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}

			ctx.ui.notify(`Unassigned task #${updated.id}`, "info");
			await refreshTasks();
			renderWidget();
			return;
		}

		case "show": {
			const taskId = taskRest[0];
			if (!taskId) {
				ctx.ui.notify("Usage: /team task show <id>", "error");
				return;
			}

			const task = await getTask(teamDir, effectiveTlId, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}

			const blocked = task.status !== "completed" && (await isTaskBlocked(teamDir, effectiveTlId, task));

			const lines: string[] = [];
			lines.push(`#${task.id} ${task.subject}`);
			lines.push(
				`status: ${task.status}${blocked ? " (blocked)" : ""}${task.owner ? ` • owner: ${task.owner}` : ""}`,
			);
			if (task.blockedBy.length) lines.push(`deps: ${task.blockedBy.join(", ")}`);
			if (task.blocks.length) lines.push(`blocks: ${task.blocks.join(", ")}`);
			lines.push("");
			lines.push(task.description);

			const result = typeof task.metadata?.result === "string" ? task.metadata.result : undefined;
			if (result) {
				lines.push("");
				lines.push("result:");
				lines.push(result);
			}

			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		case "dep": {
			const [depSub, ...depRest] = taskRest;
			if (!depSub || depSub === "help") {
				ctx.ui.notify(
					[
						"Usage:",
						"  /team task dep add <id> <depId>",
						"  /team task dep rm <id> <depId>",
						"  /team task dep ls <id>",
					].join("\n"),
					"info",
				);
				return;
			}

			switch (depSub) {
				case "add": {
					const taskId = depRest[0];
					const depId = depRest[1];
					if (!taskId || !depId) {
						ctx.ui.notify("Usage: /team task dep add <id> <depId>", "error");
						return;
					}

					const res = await addTaskDependency(teamDir, effectiveTlId, taskId, depId);
					if (!res.ok) {
						ctx.ui.notify(res.error, "error");
						return;
					}

					ctx.ui.notify(`Added dependency: #${taskId} depends on #${depId}`, "info");
					await refreshTasks();
					renderWidget();
					return;
				}

				case "rm": {
					const taskId = depRest[0];
					const depId = depRest[1];
					if (!taskId || !depId) {
						ctx.ui.notify("Usage: /team task dep rm <id> <depId>", "error");
						return;
					}

					const res = await removeTaskDependency(teamDir, effectiveTlId, taskId, depId);
					if (!res.ok) {
						ctx.ui.notify(res.error, "error");
						return;
					}

					ctx.ui.notify(`Removed dependency: #${taskId} no longer depends on #${depId}`, "info");
					await refreshTasks();
					renderWidget();
					return;
				}

				case "ls": {
					const taskId = depRest[0];
					if (!taskId) {
						ctx.ui.notify("Usage: /team task dep ls <id>", "error");
						return;
					}

					await refreshTasks();
					const tasks = getTasks();
					const task = tasks.find((t) => t.id === taskId) ?? (await getTask(teamDir, effectiveTlId, taskId));
					if (!task) {
						ctx.ui.notify(`Task not found: ${taskId}`, "error");
						return;
					}

					const blocked = task.status !== "completed" && (await isTaskBlocked(teamDir, effectiveTlId, task));

					const lines: string[] = [];
					lines.push(`#${task.id} ${task.subject}`);
					lines.push(`${blocked ? "blocked" : "unblocked"} • deps:${task.blockedBy.length} • blocks:${task.blocks.length}`);

					lines.push("");
					lines.push("blockedBy:");
					if (!task.blockedBy.length) {
						lines.push("  (none)");
					} else {
						for (const id of task.blockedBy) {
							const dep = tasks.find((t) => t.id === id) ?? (await getTask(teamDir, effectiveTlId, id));
							lines.push(dep ? `  - #${id} ${dep.status} ${dep.subject}` : `  - #${id} (missing)`);
						}
					}

					lines.push("");
					lines.push("blocks:");
					if (!task.blocks.length) {
						lines.push("  (none)");
					} else {
						for (const id of task.blocks) {
							const child = tasks.find((t) => t.id === id) ?? (await getTask(teamDir, effectiveTlId, id));
							lines.push(child ? `  - #${id} ${child.status} ${child.subject}` : `  - #${id} (missing)`);
						}
					}

					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				default: {
					ctx.ui.notify(`Unknown dep subcommand: ${depSub}`, "error");
					return;
				}
			}
		}

		case "clear": {
			const flags = taskRest.filter((a) => a.startsWith("--"));
			const argsOnly = taskRest.filter((a) => !a.startsWith("--"));
			const force = flags.includes("--force");

			const unknownFlags = flags.filter((f) => f !== "--force");
			if (unknownFlags.length) {
				ctx.ui.notify(`Unknown flag(s): ${unknownFlags.join(", ")}`, "error");
				return;
			}

			if (argsOnly.length > 1) {
				ctx.ui.notify("Usage: /team task clear [completed|all] [--force]", "error");
				return;
			}

			const modeArg = argsOnly[0];
			if (modeArg && modeArg !== "completed" && modeArg !== "all") {
				ctx.ui.notify("Usage: /team task clear [completed|all] [--force]", "error");
				return;
			}
			const mode = modeArg === "all" ? "all" : "completed";

			await refreshTasks();
			const tasks = getTasks();
			const toDelete = mode === "all" ? tasks.length : tasks.filter((t) => t.status === "completed").length;

			if (!force) {
				// Only prompt in interactive TTY mode. In RPC mode, confirm() would require
				// the host to send extension_ui_response messages.
				if (process.stdout.isTTY && process.stdin.isTTY) {
					const title = mode === "all" ? "Clear task list" : "Clear completed tasks";
					const body =
						mode === "all"
							? `Delete ALL ${toDelete} task(s) from the task list? This cannot be undone.`
							: `Delete ${toDelete} completed task(s) from the task list? This cannot be undone.`;
					const ok = await ctx.ui.confirm(title, body);
					if (!ok) return;
				} else {
					ctx.ui.notify("Refusing to clear tasks in non-interactive mode without --force", "error");
					return;
				}
			}

			const res = await clearTasks(teamDir, effectiveTlId, mode);
			const deleted = res.deletedTaskIds.length;

			if (res.errors.length) {
				ctx.ui.notify(`Cleared ${deleted} task(s) (${mode}) with ${res.errors.length} error(s)`, "warning");
				const preview = res.errors
					.slice(0, 8)
					.map((e) => `- ${path.basename(e.file)}: ${e.error}`)
					.join("\n");
				ctx.ui.notify(
					`Errors:\n${preview}${res.errors.length > 8 ? `\n... +${res.errors.length - 8} more` : ""}`,
					"warning",
				);
			} else if (deleted === 0) {
				ctx.ui.notify(`No task(s) cleared (${mode})`, "info");
			} else {
				ctx.ui.notify(`Cleared ${deleted} task(s) (${mode})`, "warning");
			}

			await refreshTasks();
			renderWidget();
			return;
		}

		case "list": {
			await refreshTasks();
			const tasks = getTasks();
			if (!tasks.length) {
				ctx.ui.notify("No tasks", "info");
				return;
			}

			const slice = tasks.slice(-30);
			const blocked = await Promise.all(
				slice.map(async (t) => (t.status === "completed" ? false : await isTaskBlocked(teamDir, effectiveTlId, t))),
			);

			const preview = slice.map((t, i) => formatTaskLine(t, { blocked: blocked[i] })).join("\n");
			ctx.ui.notify(preview, "info");
			return;
		}

		case "use": {
			const newId = taskRest[0];
			if (!newId) {
				ctx.ui.notify("Usage: /team task use <taskListId>", "error");
				return;
			}
			setTaskListId(newId);
			await ensureTeamConfig(teamDir, { teamId, taskListId: newId, leadName, style });
			ctx.ui.notify(`Task list ID set to: ${newId}`, "info");
			await refreshTasks();
			renderWidget();
			return;
		}

		default: {
			ctx.ui.notify(`Unknown task subcommand: ${taskSub}`, "error");
			return;
		}
	}
}
