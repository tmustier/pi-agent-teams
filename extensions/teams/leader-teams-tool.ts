import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { pickAgentNames, pickNamesFromPool, sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import { taskAssignmentPayload } from "./protocol.js";
import { ensureTeamConfig } from "./team-config.js";
import { getTeamsNamingRules, getTeamsStyleFromEnv, type TeamsStyle, formatMemberDisplayName } from "./teams-style.js";
import { createTask, updateTask } from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { ContextMode, WorkspaceMode, SpawnTeammateFn } from "./spawn-types.js";

type TeamsToolDelegateTask = { text: string; assignee?: string };

const TeamsActionSchema = StringEnum(["delegate", "task_assign", "task_unassign", "task_set_status"] as const, {
	description: "Teams tool action.",
	default: "delegate",
});

const TeamsTaskStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description: "Task status for action=task_set_status.",
});

const TeamsContextModeSchema = StringEnum(["fresh", "branch"] as const, {
	description: "How to initialize comrade session context. 'branch' clones the leader session branch.",
	default: "fresh",
});

const TeamsWorkspaceModeSchema = StringEnum(["shared", "worktree"] as const, {
	description: "Workspace isolation mode. 'shared' matches Claude Teams; 'worktree' creates a git worktree per comrade.",
	default: "shared",
});

const TeamsThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
	description:
		"Thinking level to use for spawned comrades (defaults to the leader's current thinking level when omitted).",
});

const TeamsDelegateTaskSchema = Type.Object({
	text: Type.String({ description: "Task / TODO text." }),
	assignee: Type.Optional(Type.String({ description: "Optional comrade name. If omitted, assigned round-robin." })),
});

const TeamsToolParamsSchema = Type.Object({
	action: Type.Optional(TeamsActionSchema),
	tasks: Type.Optional(Type.Array(TeamsDelegateTaskSchema, { description: "Tasks to delegate (action=delegate)." })),
	taskId: Type.Optional(Type.String({ description: "Task id for task mutation actions." })),
	assignee: Type.Optional(Type.String({ description: "Assignee name for action=task_assign." })),
	status: Type.Optional(TeamsTaskStatusSchema),
	teammates: Type.Optional(
		Type.Array(Type.String(), {
			description: "Explicit comrade names to use/spawn. If omitted, uses existing or auto-generates.",
		}),
	),
	maxTeammates: Type.Optional(
		Type.Integer({
			description: "If comrades list is omitted and none exist, spawn up to this many.",
			default: 4,
			minimum: 1,
			maximum: 16,
		}),
	),
	contextMode: Type.Optional(TeamsContextModeSchema),
	workspaceMode: Type.Optional(TeamsWorkspaceModeSchema),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override for spawned comrades. Use '<provider>/<modelId>' (e.g. 'anthropic/claude-sonnet-4'). If you pass only '<modelId>', the provider is inherited from the leader when available.",
		}),
	),
	thinking: Type.Optional(TeamsThinkingLevelSchema),
});

type TeamsToolParamsType = Static<typeof TeamsToolParamsSchema>;

export function registerTeamsTool(opts: {
	pi: ExtensionAPI;
	teammates: Map<string, TeammateRpc>;
	spawnTeammate: SpawnTeammateFn;
	getTeamId: (ctx: Parameters<SpawnTeammateFn>[0]) => string;
	getTaskListId: () => string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): void {
	const { pi, teammates, spawnTeammate, getTeamId, getTaskListId, refreshTasks, renderWidget } = opts;

	pi.registerTool({
		name: "teams",
		label: "Teams",
		description: [
			"Spawn comrade agents and delegate tasks. Each comrade is a child Pi process that executes work autonomously and reports back.",
			"You can also mutate existing tasks (assign, unassign, set status) without user slash commands.",
			"Provide a list of tasks with optional assignees; comrades are spawned automatically and assigned round-robin if unspecified.",
			"Options: contextMode=branch (clone session context), workspaceMode=worktree (git worktree isolation).",
			"Optional overrides: model='<provider>/<modelId>' and thinking (off|minimal|low|medium|high|xhigh).",
			"For governance, the user can run /team delegate on (leader restricted to coordination) or /team spawn <name> plan (worker needs plan approval).",
		].join(" "),
		parameters: TeamsToolParamsSchema,

		async execute(_toolCallId, params: TeamsToolParamsType, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action ?? "delegate";
			const teamId = getTeamId(ctx);
			const teamDir = getTeamDir(teamId);
			const taskListId = getTaskListId();
			const effectiveTlId = taskListId ?? teamId;
			const cfg = await ensureTeamConfig(teamDir, {
				teamId,
				taskListId: effectiveTlId,
				leadName: "team-lead",
				style: getTeamsStyleFromEnv(),
			});
			const style: TeamsStyle = cfg.style ?? getTeamsStyleFromEnv();

			const refreshUi = async (): Promise<void> => {
				await refreshTasks();
				renderWidget();
			};

			if (action === "task_set_status") {
				const taskId = params.taskId?.trim();
				const status = params.status;
				if (!taskId || !status) {
					return {
						content: [{ type: "text", text: "task_set_status requires taskId and status" }],
						details: { action, taskId, status },
					};
				}

				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					if (cur.status === status) return cur;
					const metadata = { ...(cur.metadata ?? {}) };
					if (status === "completed") metadata.completedAt = new Date().toISOString();
					if (status !== "completed" && cur.status === "completed") metadata.reopenedAt = new Date().toISOString();
					return { ...cur, status, metadata };
				});
				if (!updated) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						details: { action, taskId, status },
					};
				}

				await refreshUi();
				return {
					content: [{ type: "text", text: `Updated task #${updated.id}: status=${updated.status}` }],
					details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id, status: updated.status },
				};
			}

			if (action === "task_unassign") {
				const taskId = params.taskId?.trim();
				if (!taskId) {
					return {
						content: [{ type: "text", text: "task_unassign requires taskId" }],
						details: { action },
					};
				}

				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					if (!cur.owner) return cur;
					if (cur.status === "completed") return { ...cur, owner: undefined };
					const metadata = { ...(cur.metadata ?? {}) };
					metadata.unassignedAt = new Date().toISOString();
					metadata.unassignedBy = cfg.leadName;
					metadata.unassignedReason = "teams-tool";
					return { ...cur, owner: undefined, status: "pending", metadata };
				});
				if (!updated) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						details: { action, taskId },
					};
				}

				await refreshUi();
				return {
					content: [{ type: "text", text: `Unassigned task #${updated.id}` }],
					details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id },
				};
			}

			if (action === "task_assign") {
				const taskId = params.taskId?.trim();
				const assignee = sanitizeName(params.assignee ?? "");
				if (!taskId || !assignee) {
					return {
						content: [{ type: "text", text: "task_assign requires taskId and assignee" }],
						details: { action, taskId, assignee: params.assignee },
					};
				}

				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					const metadata = { ...(cur.metadata ?? {}) };
					metadata.reassignedAt = new Date().toISOString();
					metadata.reassignedBy = cfg.leadName;
					metadata.reassignedTo = assignee;
					if (cur.status === "completed") return { ...cur, owner: assignee, metadata };
					return { ...cur, owner: assignee, status: "pending", metadata };
				});
				if (!updated) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						details: { action, taskId, assignee },
					};
				}

				await writeToMailbox(teamDir, effectiveTlId, assignee, {
					from: cfg.leadName,
					text: JSON.stringify(taskAssignmentPayload(updated, cfg.leadName)),
					timestamp: new Date().toISOString(),
				});

				await refreshUi();
				return {
					content: [{ type: "text", text: `Assigned task #${updated.id} to ${formatMemberDisplayName(style, assignee)}` }],
					details: { action, teamId, taskListId: effectiveTlId, taskId: updated.id, assignee },
				};
			}

			if (action !== "delegate") {
				return {
					content: [{ type: "text", text: `Unsupported action: ${String(action)}` }],
					details: { action },
				};
			}

			const inputTasks: TeamsToolDelegateTask[] = params.tasks ?? [];
			if (inputTasks.length === 0) {
				return {
					content: [{ type: "text", text: "No tasks provided. Provide tasks: [{text, assignee?}, ...]" }],
					details: { action },
				};
			}

			const contextMode: ContextMode = params.contextMode === "branch" ? "branch" : "fresh";
			const requestedWorkspaceMode: WorkspaceMode = params.workspaceMode === "worktree" ? "worktree" : "shared";
			const modelOverride = params.model?.trim();
			const spawnModel = modelOverride && modelOverride.length > 0 ? modelOverride : undefined;
			const spawnThinking = params.thinking;

			let teammateNames: string[] = [];
			const explicit = params.teammates;
			if (explicit && explicit.length) {
				teammateNames = explicit.map((n) => sanitizeName(n)).filter((n) => n.length > 0);
			}

			if (teammateNames.length === 0 && teammates.size > 0) {
				teammateNames = Array.from(teammates.keys());
			}

			if (teammateNames.length === 0) {
				const maxTeammates = Math.max(1, Math.min(16, params.maxTeammates ?? 4));
				const count = Math.min(maxTeammates, inputTasks.length);
				const taken = new Set(teammates.keys());
				const naming = getTeamsNamingRules(style);
				teammateNames =
					naming.autoNameStrategy.kind === "agent"
						? pickAgentNames(count, taken)
						: pickNamesFromPool({
							pool: naming.autoNameStrategy.pool,
							count,
							taken,
							fallbackBase: naming.autoNameStrategy.fallbackBase,
						});
			}

			const spawned: string[] = [];
			const warnings: string[] = [];

			for (const name of teammateNames) {
				if (signal?.aborted) break;
				if (teammates.has(name)) continue;
				const res = await spawnTeammate(ctx, {
					name,
					mode: contextMode,
					workspaceMode: requestedWorkspaceMode,
					model: spawnModel,
					thinking: spawnThinking,
				});
				if (!res.ok) {
					warnings.push(`Failed to spawn '${name}': ${res.error}`);
					continue;
				}
				spawned.push(res.name);
				warnings.push(...res.warnings);
			}

			const assignments: Array<{ taskId: string; assignee: string; subject: string }> = [];
			let rr = 0;
			for (const t of inputTasks) {
				if (signal?.aborted) break;

				const text = t.text.trim();
				if (!text) {
					warnings.push("Skipping empty task");
					continue;
				}

				const explicitAssignee = t.assignee ? sanitizeName(t.assignee) : undefined;
				const assignee = explicitAssignee ?? teammateNames[rr++ % teammateNames.length];
				if (!assignee) {
					warnings.push(`No assignee available for task: ${text.slice(0, 60)}`);
					continue;
				}

				if (!teammates.has(assignee)) {
					const res = await spawnTeammate(ctx, {
						name: assignee,
						mode: contextMode,
						workspaceMode: requestedWorkspaceMode,
						model: spawnModel,
						thinking: spawnThinking,
					});
					if (res.ok) {
						spawned.push(res.name);
						warnings.push(...res.warnings);
					} else {
						warnings.push(`Failed to spawn assignee '${assignee}': ${res.error}`);
						continue;
					}
				}

				const description = text;
				const firstLine = description.split("\n").at(0) ?? "";
				const subject = firstLine.slice(0, 120);
				const task = await createTask(teamDir, effectiveTlId, { subject, description, owner: assignee });

				await writeToMailbox(teamDir, effectiveTlId, assignee, {
					from: cfg.leadName,
					text: JSON.stringify(taskAssignmentPayload(task, cfg.leadName)),
					timestamp: new Date().toISOString(),
				});

				assignments.push({ taskId: task.id, assignee, subject });
			}

			void refreshTasks().finally(renderWidget);

			const lines: string[] = [];
			if (spawned.length) {
				lines.push(`Spawned: ${spawned.map((n) => formatMemberDisplayName(style, n)).join(", ")}`);
			}
			lines.push(`Delegated ${assignments.length} task(s):`);
			for (const a of assignments) {
				lines.push(`- #${a.taskId} → ${formatMemberDisplayName(style, a.assignee)}: ${a.subject}`);
			}
			if (warnings.length) {
				lines.push("\nWarnings:");
				for (const w of warnings) lines.push(`- ${w}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action,
					teamId,
					taskListId: effectiveTlId,
					contextMode,
					workspaceMode: requestedWorkspaceMode,
					model: spawnModel,
					thinking: spawnThinking,
					spawned,
					assignments,
					warnings,
				},
			};
		},
	});
}
