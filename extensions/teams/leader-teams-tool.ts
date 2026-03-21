import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { pickAgentNames, pickNamesFromPool, sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import { TEAM_MAILBOX_NS, taskAssignmentPayload } from "./protocol.js";
import { ensureTeamConfig, setMemberStatus, updateTeamHooksPolicy } from "./team-config.js";
import { getTeamsNamingRules, getTeamsStyleFromEnv, type TeamsStyle, formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import {
	formatProviderModel,
	isDeprecatedTeammateModelId,
	resolveTeammateModelSelection,
	type TeammateModelSource,
} from "./model-policy.js";
import {
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
	type TeamsHookFailureAction,
	type TeamsHookFollowupOwnerPolicy,
} from "./hooks.js";
import {
	addTaskDependency,
	createTask,
	getTask,
	isTaskBlocked,
	listTasks,
	removeTaskDependency,
	unassignTasksForAgent,
	updateTask,
} from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { ContextMode, WorkspaceMode, SpawnTeammateFn } from "./spawn-types.js";

type TeamsToolDelegateTask = { text: string; assignee?: string };

function describeModelSource(source: TeammateModelSource): string {
	if (source === "override") return "override";
	if (source === "inherit_leader") return "leader";
	return "teammate-default";
}

const TeamsActionSchema = StringEnum(
	[
		"delegate",
		"task_assign",
		"task_unassign",
		"task_set_status",
		"task_dep_add",
		"task_dep_rm",
		"task_dep_ls",
		"message_dm",
		"message_broadcast",
		"message_steer",
		"member_spawn",
		"member_shutdown",
		"member_kill",
		"member_prune",
		"team_done",
		"plan_approve",
		"plan_reject",
		"hooks_policy_get",
		"hooks_policy_set",
		"model_policy_get",
		"model_policy_check",
	] as const,
	{
		description: "Teams tool action.",
		default: "delegate",
	},
);

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

const TeamsHookFailureActionSchema = StringEnum(["warn", "followup", "reopen", "reopen_followup"] as const, {
	description: "Hook failure policy for hooks_policy_set.",
});

const TeamsHookFollowupOwnerSchema = StringEnum(["member", "lead", "none"] as const, {
	description: "Follow-up owner policy for hooks_policy_set.",
});

const TeamsDelegateTaskSchema = Type.Object({
	text: Type.String({ description: "Task / TODO text." }),
	assignee: Type.Optional(Type.String({ description: "Optional comrade name. If omitted, assigned round-robin." })),
});

const TeamsToolParamsSchema = Type.Object({
	action: Type.Optional(TeamsActionSchema),
	tasks: Type.Optional(Type.Array(TeamsDelegateTaskSchema, { description: "Tasks to delegate (action=delegate)." })),
	taskId: Type.Optional(Type.String({ description: "Task id for task mutation actions." })),
	depId: Type.Optional(Type.String({ description: "Dependency task id for task_dep_add/task_dep_rm." })),
	assignee: Type.Optional(Type.String({ description: "Assignee name for action=task_assign." })),
	status: Type.Optional(TeamsTaskStatusSchema),
	name: Type.Optional(Type.String({ description: "Teammate name for member/message actions." })),
	message: Type.Optional(Type.String({ description: "Message body for messaging actions." })),
	reason: Type.Optional(Type.String({ description: "Optional reason for lifecycle actions." })),
	feedback: Type.Optional(Type.String({ description: "Feedback for action=plan_reject." })),
	all: Type.Optional(Type.Boolean({ description: "For member_shutdown/member_prune: apply to all workers. For team_done: force even with in-progress tasks." })),
	planRequired: Type.Optional(Type.Boolean({ description: "For member_spawn, start worker in plan-required mode." })),
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
				"Optional model override for spawned comrades. Use '<provider>/<modelId>'. If you pass only '<modelId>', the provider is inherited from the leader when available.",
		}),
	),
	thinking: Type.Optional(TeamsThinkingLevelSchema),
	hookFailureAction: Type.Optional(TeamsHookFailureActionSchema),
	hookMaxReopensPerTask: Type.Optional(
		Type.Integer({ minimum: 0, description: "Per-task auto-reopen cap for hooks_policy_set (0 disables auto-reopen)." }),
	),
	hookFollowupOwner: Type.Optional(TeamsHookFollowupOwnerSchema),
	hooksPolicyReset: Type.Optional(Type.Boolean({ description: "For hooks_policy_set, clear team-level overrides before applying fields." })),
	urgent: Type.Optional(Type.Boolean({ description: "For message_dm/message_broadcast: interrupt the recipient's active turn via steering instead of waiting for idle. Use sparingly." })),
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
	hideWidget: () => void;
	stopAllTeammates: (reason: string) => Promise<void>;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
}): void {
	const { pi, teammates, spawnTeammate, getTeamId, getTaskListId, refreshTasks, renderWidget, hideWidget, stopAllTeammates, pendingPlanApprovals } = opts;

	pi.registerTool({
		name: "teams",
		label: "Teams",
		description: [
			"Spawn comrade agents and delegate tasks. Each comrade is a child Pi process that executes work autonomously and reports back.",
			"You can also mutate existing tasks (assign, unassign, set status, dependencies), send team messages, run teammate lifecycle actions, and manage hooks/model policy without user slash commands.",
			"Use team_done to end a team run when all tasks are complete (stops teammates, hides widget).",
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
			const strings = getTeamsStrings(style);

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

			if (action === "task_dep_add" || action === "task_dep_rm") {
				const taskId = params.taskId?.trim();
				const depId = params.depId?.trim();
				if (!taskId || !depId) {
					return {
						content: [{ type: "text", text: `${action} requires taskId and depId` }],
						details: { action, taskId, depId },
					};
				}

				const res = action === "task_dep_add"
					? await addTaskDependency(teamDir, effectiveTlId, taskId, depId)
					: await removeTaskDependency(teamDir, effectiveTlId, taskId, depId);
				if (!res.ok) {
					return {
						content: [{ type: "text", text: res.error }],
						details: { action, taskId, depId, error: res.error },
					};
				}

				await refreshUi();
				return {
					content: [{ type: "text", text: action === "task_dep_add" ? `Added dependency: #${taskId} depends on #${depId}` : `Removed dependency: #${taskId} no longer depends on #${depId}` }],
					details: { action, teamId, taskListId: effectiveTlId, taskId, depId },
				};
			}

			if (action === "task_dep_ls") {
				const taskId = params.taskId?.trim();
				if (!taskId) {
					return {
						content: [{ type: "text", text: "task_dep_ls requires taskId" }],
						details: { action },
					};
				}

				const task = await getTask(teamDir, effectiveTlId, taskId);
				if (!task) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						details: { action, taskId },
					};
				}
				const blocked = task.status !== "completed" && (await isTaskBlocked(teamDir, effectiveTlId, task));
				const all = await listTasks(teamDir, effectiveTlId);
				const byId = new Map<string, (typeof all)[number]>();
				for (const t of all) byId.set(t.id, t);

				const lines: string[] = [];
				lines.push(`#${task.id} ${task.subject}`);
				lines.push(`${blocked ? "blocked" : "unblocked"} • deps:${task.blockedBy.length} • blocks:${task.blocks.length}`);
				lines.push("");
				lines.push("blockedBy:");
				if (task.blockedBy.length === 0) {
					lines.push("  (none)");
				} else {
					for (const id of task.blockedBy) {
						const dep = byId.get(id) ?? (await getTask(teamDir, effectiveTlId, id));
						lines.push(dep ? `  - #${id} ${dep.status} ${dep.subject}` : `  - #${id} (missing)`);
					}
				}
				lines.push("");
				lines.push("blocks:");
				if (task.blocks.length === 0) {
					lines.push("  (none)");
				} else {
					for (const id of task.blocks) {
						const child = byId.get(id) ?? (await getTask(teamDir, effectiveTlId, id));
						lines.push(child ? `  - #${id} ${child.status} ${child.subject}` : `  - #${id} (missing)`);
					}
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { action, teamId, taskListId: effectiveTlId, taskId, blocked },
				};
			}

			if (action === "message_dm") {
				const nameRaw = params.name?.trim();
				const message = params.message?.trim();
				if (!nameRaw || !message) {
					return {
						content: [{ type: "text", text: "message_dm requires name and message" }],
						details: { action, name: nameRaw },
					};
				}
				const name = sanitizeName(nameRaw);
				const isUrgent = params.urgent === true;
				await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
					from: cfg.leadName,
					text: message,
					timestamp: new Date().toISOString(),
					...(isUrgent ? { urgent: true } : {}),
				});
				const verb = isUrgent ? "Urgent DM" : "DM";
				return {
					content: [{ type: "text", text: `${verb} queued for ${formatMemberDisplayName(style, name)}` }],
					details: { action, teamId, name, urgent: isUrgent, mailboxNamespace: TEAM_MAILBOX_NS },
				};
			}

			if (action === "message_broadcast") {
				const message = params.message?.trim();
				if (!message) {
					return {
						content: [{ type: "text", text: "message_broadcast requires message" }],
						details: { action },
					};
				}
				const recipients = new Set<string>();
				for (const m of cfg.members) {
					if (m.role === "worker") recipients.add(m.name);
				}
				for (const name of teammates.keys()) recipients.add(name);
				const allTasks = await listTasks(teamDir, effectiveTlId);
				for (const t of allTasks) {
					if (t.owner && t.owner !== cfg.leadName) recipients.add(t.owner);
				}
				const names = Array.from(recipients).sort();
				if (names.length === 0) {
					return {
						content: [{ type: "text", text: `No ${strings.memberTitle.toLowerCase()}s to broadcast to` }],
						details: { action, recipients: [] },
					};
				}
				const isUrgent = params.urgent === true;
				const ts = new Date().toISOString();
				await Promise.all(
					names.map((name) =>
						writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: cfg.leadName,
							text: message,
							timestamp: ts,
							...(isUrgent ? { urgent: true } : {}),
						}),
					),
				);
				const verb = isUrgent ? "Urgent broadcast" : "Broadcast";
				return {
					content: [{ type: "text", text: `${verb} queued for ${names.length} ${strings.memberTitle.toLowerCase()}(s): ${names.map((n) => formatMemberDisplayName(style, n)).join(", ")}` }],
					details: { action, teamId, recipients: names, urgent: isUrgent, mailboxNamespace: TEAM_MAILBOX_NS },
				};
			}

			if (action === "message_steer") {
				const nameRaw = params.name?.trim();
				const message = params.message?.trim();
				if (!nameRaw || !message) {
					return {
						content: [{ type: "text", text: "message_steer requires name and message" }],
						details: { action, name: nameRaw },
					};
				}
				const name = sanitizeName(nameRaw);
				const rpc = teammates.get(name);
				if (!rpc) {
					return {
						content: [{ type: "text", text: `Unknown ${strings.memberTitle.toLowerCase()}: ${name}` }],
						details: { action, name },
					};
				}
				await rpc.steer(message);
				renderWidget();
				return {
					content: [{ type: "text", text: `Steering sent to ${formatMemberDisplayName(style, name)}` }],
					details: { action, teamId, name },
				};
			}

			if (action === "member_spawn") {
				const nameRaw = params.name?.trim();
				const name = sanitizeName(nameRaw ?? "");
				if (!name) {
					return {
						content: [{ type: "text", text: "member_spawn requires name" }],
						details: { action, name: nameRaw },
					};
				}
				if (teammates.has(name)) {
					return {
						content: [{ type: "text", text: `${formatMemberDisplayName(style, name)} is already running` }],
						details: { action, teamId, name, alreadyRunning: true },
					};
				}

				const contextMode: ContextMode = params.contextMode === "branch" ? "branch" : "fresh";
				const workspaceMode: WorkspaceMode = params.workspaceMode === "worktree" ? "worktree" : "shared";
				const modelOverride = params.model?.trim();
				const spawnModel = modelOverride && modelOverride.length > 0 ? modelOverride : undefined;
				const res = await spawnTeammate(ctx, {
					name,
					mode: contextMode,
					workspaceMode,
					model: spawnModel,
					thinking: params.thinking,
					planRequired: params.planRequired === true,
				});

				if (!res.ok) {
					return {
						content: [{ type: "text", text: `Failed to spawn ${formatMemberDisplayName(style, name)}: ${res.error}` }],
						details: { action, teamId, name, error: res.error },
					};
				}

				await refreshUi();
				const lines: string[] = [
					`Spawned ${formatMemberDisplayName(style, res.name)} (${res.mode}/${res.workspaceMode})`,
				];
				if (res.model) lines.push(`model: ${res.model}`);
				if (res.thinking) lines.push(`thinking: ${res.thinking}`);
				if (res.note) lines.push(`note: ${res.note}`);
				for (const w of res.warnings) lines.push(`warning: ${w}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						teamId,
						name: res.name,
						mode: res.mode,
						workspaceMode: res.workspaceMode,
						model: res.model,
						thinking: res.thinking,
						warnings: res.warnings,
					},
				};
			}

			if (action === "member_kill") {
				const nameRaw = params.name?.trim();
				const name = sanitizeName(nameRaw ?? "");
				if (!name) {
					return {
						content: [{ type: "text", text: "member_kill requires name" }],
						details: { action, name: nameRaw },
					};
				}
				const rpc = teammates.get(name);
				if (!rpc) {
					return {
						content: [{ type: "text", text: `Unknown ${strings.memberTitle.toLowerCase()}: ${name}` }],
						details: { action, name },
					};
				}

				await rpc.stop();
				teammates.delete(name);
				await unassignTasksForAgent(teamDir, effectiveTlId, name, `${formatMemberDisplayName(style, name)} ${strings.killedVerb}`);
				await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });
				await refreshUi();
				return {
					content: [{ type: "text", text: `${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)` }],
					details: { action, teamId, name },
				};
			}

			if (action === "member_shutdown") {
				const reason = params.reason?.trim();
				const all = params.all === true;
				const explicitName = sanitizeName(params.name?.trim() ?? "");
				if (!all && !explicitName) {
					return {
						content: [{ type: "text", text: "member_shutdown requires name (or all=true)" }],
						details: { action },
					};
				}

				const recipients = new Set<string>();
				if (all) {
					for (const m of cfg.members) {
						if (m.role === "worker" && m.status === "online") recipients.add(m.name);
					}
					for (const name of teammates.keys()) recipients.add(name);
				} else if (explicitName) {
					recipients.add(explicitName);
				}

				const names = Array.from(recipients).sort();
				if (names.length === 0) {
					return {
						content: [{ type: "text", text: `No ${strings.memberTitle.toLowerCase()}s to shut down` }],
						details: { action, all, recipients: [] },
					};
				}

				const ts = new Date().toISOString();
				for (const name of names) {
					const requestId = randomUUID();
					await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
						from: cfg.leadName,
						text: JSON.stringify({
							type: "shutdown_request",
							requestId,
							from: cfg.leadName,
							timestamp: ts,
							...(reason ? { reason } : {}),
						}),
						timestamp: ts,
					});
					await setMemberStatus(teamDir, name, "online", {
						meta: {
							shutdownRequestedAt: ts,
							shutdownRequestId: requestId,
							...(reason ? { shutdownReason: reason } : {}),
						},
					});
				}

				await refreshUi();
				return {
					content: [{ type: "text", text: `Shutdown requested for ${names.length} ${strings.memberTitle.toLowerCase()}(s): ${names.map((n) => formatMemberDisplayName(style, n)).join(", ")}` }],
					details: { action, teamId, names, all, reason },
				};
			}

			if (action === "member_prune") {
				const all = params.all === true;
				const workers = cfg.members.filter((m) => m.role === "worker");
				if (workers.length === 0) {
					return {
						content: [{ type: "text", text: `No ${strings.memberTitle.toLowerCase()}s to prune` }],
						details: { action, teamId, pruned: [] },
					};
				}

				const tasks = await listTasks(teamDir, effectiveTlId);
				const inProgressOwners = new Set<string>();
				for (const t of tasks) {
					if (t.owner && t.status === "in_progress") inProgressOwners.add(t.owner);
				}

				const cutoffMs = 60 * 60 * 1000;
				const now = Date.now();
				const pruned: string[] = [];
				for (const m of workers) {
					if (teammates.has(m.name)) continue;
					if (inProgressOwners.has(m.name)) continue;
					if (!all) {
						const lastSeen = m.lastSeenAt ? Date.parse(m.lastSeenAt) : Number.NaN;
						if (!Number.isFinite(lastSeen)) continue;
						if (now - lastSeen < cutoffMs) continue;
					}
					await setMemberStatus(teamDir, m.name, "offline", {
						meta: { prunedAt: new Date().toISOString(), prunedBy: "teams-tool" },
					});
					pruned.push(m.name);
				}

				await refreshUi();
				if (pruned.length === 0) {
					return {
						content: [{ type: "text", text: `No stale ${strings.memberTitle.toLowerCase()}s to prune${all ? "" : " (use all=true to force)"}` }],
						details: { action, teamId, pruned },
					};
				}
				return {
					content: [{ type: "text", text: `Pruned ${pruned.length} stale ${strings.memberTitle.toLowerCase()}(s): ${pruned.map((n) => formatMemberDisplayName(style, n)).join(", ")}` }],
					details: { action, teamId, pruned },
				};
			}

			if (action === "team_done") {
				const tasks = await listTasks(teamDir, effectiveTlId);
				const inProgress = tasks.filter((t) => t.status === "in_progress");
				const force = params.all === true;

				if (inProgress.length > 0 && !force) {
					return {
						content: [{
							type: "text",
							text: `${inProgress.length} task(s) still in progress. Set all=true to force.`,
						}],
						details: {
							action,
							teamId,
							status: "blocked",
							reason: "tasks_in_progress",
							inProgress: inProgress.length,
							hint: "Set all=true to force, or wait for tasks to complete.",
						},
					};
				}

				// Stop all RPC teammates (reuses leader's stopAllTeammates for proper
				// event unsub + tracker/transcript cleanup — avoids stale state on reuse).
				await stopAllTeammates("team done");

				// Mark config workers offline + send shutdown mailbox messages
				const cfgWorkers = cfg.members.filter((m) => m.role === "worker" && m.status === "online");
				for (const m of cfgWorkers) {
					if (teammates.has(m.name)) continue; // already stopped via RPC above
					const ts = new Date().toISOString();
					try {
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, m.name, {
							from: cfg.leadName,
							text: JSON.stringify({
								type: "shutdown_request",
								requestId: randomUUID(),
								from: cfg.leadName,
								timestamp: ts,
								reason: "Team done",
							}),
							timestamp: ts,
						});
					} catch {
						// ignore mailbox errors
					}
					await setMemberStatus(teamDir, m.name, "offline", {
						meta: { stoppedReason: "team-done", stoppedAt: ts },
					});
				}

				await refreshTasks();
				hideWidget();

				const completed = tasks.filter((t) => t.status === "completed").length;
				const pending = tasks.filter((t) => t.status === "pending").length;
				return {
					content: [{
						type: "text",
						text: `Team done. ${tasks.length} task(s): ${completed} completed, ${pending} pending${inProgress.length > 0 ? `, ${inProgress.length} were in-progress (unassigned)` : ""}. Widget hidden.`,
					}],
					details: {
						action,
						teamId,
						status: "succeeded",
						total: tasks.length,
						completed,
						pending,
						unassigned: inProgress.length,
					},
				};
			}

			if (action === "plan_approve") {
				const nameRaw = params.name?.trim();
				const name = sanitizeName(nameRaw ?? "");
				if (!name) {
					return {
						content: [{ type: "text", text: "plan_approve requires name" }],
						details: { action, name: nameRaw },
					};
				}
				const pending = pendingPlanApprovals.get(name);
				if (!pending) {
					return {
						content: [{ type: "text", text: `No pending plan approval for ${name}` }],
						details: { action, name },
					};
				}
				const ts = new Date().toISOString();
				await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
					from: cfg.leadName,
					text: JSON.stringify({
						type: "plan_approved",
						requestId: pending.requestId,
						from: cfg.leadName,
						timestamp: ts,
					}),
					timestamp: ts,
				});
				pendingPlanApprovals.delete(name);
				return {
					content: [{ type: "text", text: `Approved plan for ${formatMemberDisplayName(style, name)}` }],
					details: { action, teamId, name, requestId: pending.requestId, taskId: pending.taskId },
				};
			}

			if (action === "plan_reject") {
				const nameRaw = params.name?.trim();
				const name = sanitizeName(nameRaw ?? "");
				if (!name) {
					return {
						content: [{ type: "text", text: "plan_reject requires name" }],
						details: { action, name: nameRaw },
					};
				}
				const pending = pendingPlanApprovals.get(name);
				if (!pending) {
					return {
						content: [{ type: "text", text: `No pending plan approval for ${name}` }],
						details: { action, name },
					};
				}
				const feedback = params.feedback?.trim() || params.reason?.trim() || "Plan rejected";
				const ts = new Date().toISOString();
				await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
					from: cfg.leadName,
					text: JSON.stringify({
						type: "plan_rejected",
						requestId: pending.requestId,
						from: cfg.leadName,
						feedback,
						timestamp: ts,
					}),
					timestamp: ts,
				});
				pendingPlanApprovals.delete(name);
				return {
					content: [{ type: "text", text: `Rejected plan for ${formatMemberDisplayName(style, name)}: ${feedback}` }],
					details: { action, teamId, name, requestId: pending.requestId, taskId: pending.taskId, feedback },
				};
			}

			if (action === "model_policy_get") {
				const leaderProvider = ctx.model?.provider;
				const leaderModelId = ctx.model?.id;
				const leaderModel = formatProviderModel(leaderProvider, leaderModelId);
				const leaderModelDeprecated = leaderModelId ? isDeprecatedTeammateModelId(leaderModelId) : false;
				const resolved = resolveTeammateModelSelection({
					leaderProvider,
					leaderModelId,
				});
				if (!resolved.ok) {
					return {
						content: [{ type: "text", text: `Model policy resolution failed: ${resolved.error}` }],
						details: {
							action,
							teamId,
							error: resolved.error,
							reason: resolved.reason,
						},
					};
				}

				const effectiveModel = formatProviderModel(resolved.value.provider, resolved.value.modelId);
				const lines: string[] = [
					"Model policy",
					"deprecated model family: claude-sonnet-4* (except claude-sonnet-4-5 / claude-sonnet-4.5)",
					`leader model: ${leaderModel ?? "(unknown)"}`,
					`leader model deprecated: ${leaderModelDeprecated ? "yes" : "no"}`,
					`default teammate selection: source=${describeModelSource(resolved.value.source)}, model=${effectiveModel ?? "(teammate default)"}`,
					"override forms: '<provider>/<modelId>' or '<modelId>' (inherits leader provider when available)",
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						teamId,
						deprecatedPolicy: {
							family: "claude-sonnet-4",
							allowedExceptions: ["claude-sonnet-4-5", "claude-sonnet-4.5"],
						},
						leader: {
							provider: leaderProvider,
							modelId: leaderModelId,
							model: leaderModel,
							deprecated: leaderModelDeprecated,
						},
						defaultSelection: {
							source: resolved.value.source,
							provider: resolved.value.provider,
							modelId: resolved.value.modelId,
							model: effectiveModel,
							warnings: resolved.value.warnings,
						},
					},
				};
			}

			if (action === "model_policy_check") {
				const modelInput = params.model?.trim();
				const resolved = resolveTeammateModelSelection({
					modelOverride: modelInput,
					leaderProvider: ctx.model?.provider,
					leaderModelId: ctx.model?.id,
				});

				if (!resolved.ok) {
					const lines = [
						"Model policy check: rejected",
						`input: ${modelInput ?? "(none)"}`,
						`reason: ${resolved.error}`,
					];
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							action,
							teamId,
							accepted: false,
							input: modelInput,
							error: resolved.error,
							reason: resolved.reason,
						},
					};
				}

				const resolvedModel = formatProviderModel(resolved.value.provider, resolved.value.modelId);
				const lines = [
					"Model policy check: accepted",
					`input: ${modelInput ?? "(none)"}`,
					`source: ${describeModelSource(resolved.value.source)}`,
					`resolved model: ${resolvedModel ?? "(teammate default)"}`,
				];
				for (const warning of resolved.value.warnings) lines.push(`warning: ${warning}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						teamId,
						accepted: true,
						input: modelInput,
						source: resolved.value.source,
						provider: resolved.value.provider,
						modelId: resolved.value.modelId,
						model: resolvedModel,
						warnings: resolved.value.warnings,
					},
				};
			}

			if (action === "hooks_policy_get") {
				const configuredFailureAction: TeamsHookFailureAction | undefined = cfg.hooks?.failureAction;
				const configuredFollowupOwner: TeamsHookFollowupOwnerPolicy | undefined = cfg.hooks?.followupOwner;
				const configuredMaxReopens = cfg.hooks?.maxReopensPerTask;

				const effectiveFailureAction = getTeamsHookFailureAction(process.env, configuredFailureAction);
				const effectiveFollowupOwner = getTeamsHookFollowupOwnerPolicy(process.env, configuredFollowupOwner);
				const effectiveMaxReopens = getTeamsHookMaxReopensPerTask(process.env, configuredMaxReopens);

				const lines = [
					"Hooks policy",
					`configured: failureAction=${configuredFailureAction ?? "(env default)"}, maxReopensPerTask=${configuredMaxReopens ?? "(env default)"}, followupOwner=${configuredFollowupOwner ?? "(env default)"}`,
					`effective: failureAction=${effectiveFailureAction}, maxReopensPerTask=${String(effectiveMaxReopens)}, followupOwner=${effectiveFollowupOwner}`,
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						teamId,
						configured: {
							failureAction: configuredFailureAction,
							maxReopensPerTask: configuredMaxReopens,
							followupOwner: configuredFollowupOwner,
						},
						effective: {
							failureAction: effectiveFailureAction,
							maxReopensPerTask: effectiveMaxReopens,
							followupOwner: effectiveFollowupOwner,
						},
					},
				};
			}

			if (action === "hooks_policy_set") {
				const reset = params.hooksPolicyReset === true;
				const nextFailureAction = params.hookFailureAction;
				const nextMaxReopens = params.hookMaxReopensPerTask;
				const nextFollowupOwner = params.hookFollowupOwner;
				if (!reset && nextFailureAction === undefined && nextMaxReopens === undefined && nextFollowupOwner === undefined) {
					return {
						content: [
							{
								type: "text",
								text: "hooks_policy_set requires at least one policy field (or hooksPolicyReset=true)",
							},
						],
						details: { action, reset },
					};
				}

				const updatedCfg = await updateTeamHooksPolicy(teamDir, (current) => {
					const next = reset ? {} : { ...current };
					if (nextFailureAction !== undefined) next.failureAction = nextFailureAction;
					if (nextMaxReopens !== undefined) next.maxReopensPerTask = nextMaxReopens;
					if (nextFollowupOwner !== undefined) next.followupOwner = nextFollowupOwner;
					if (
						next.failureAction === undefined &&
						next.maxReopensPerTask === undefined &&
						next.followupOwner === undefined
					) {
						return undefined;
					}
					return next;
				});
				if (!updatedCfg) {
					return {
						content: [{ type: "text", text: "Failed to update hooks policy: team config missing" }],
						details: { action, teamId },
					};
				}

				await refreshUi();
				const configuredFailureAction: TeamsHookFailureAction | undefined = updatedCfg.hooks?.failureAction;
				const configuredFollowupOwner: TeamsHookFollowupOwnerPolicy | undefined = updatedCfg.hooks?.followupOwner;
				const configuredMaxReopens = updatedCfg.hooks?.maxReopensPerTask;
				const effectiveFailureAction = getTeamsHookFailureAction(process.env, configuredFailureAction);
				const effectiveFollowupOwner = getTeamsHookFollowupOwnerPolicy(process.env, configuredFollowupOwner);
				const effectiveMaxReopens = getTeamsHookMaxReopensPerTask(process.env, configuredMaxReopens);
				const lines = [
					"Updated hooks policy",
					`configured: failureAction=${configuredFailureAction ?? "(env default)"}, maxReopensPerTask=${configuredMaxReopens ?? "(env default)"}, followupOwner=${configuredFollowupOwner ?? "(env default)"}`,
					`effective: failureAction=${effectiveFailureAction}, maxReopensPerTask=${String(effectiveMaxReopens)}, followupOwner=${effectiveFollowupOwner}`,
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						teamId,
						reset,
						configured: {
							failureAction: configuredFailureAction,
							maxReopensPerTask: configuredMaxReopens,
							followupOwner: configuredFollowupOwner,
						},
						effective: {
							failureAction: effectiveFailureAction,
							maxReopensPerTask: effectiveMaxReopens,
							followupOwner: effectiveFollowupOwner,
						},
					},
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
				if (spawnModel) lines.push(`model: ${spawnModel}`);
				if (spawnThinking) lines.push(`thinking: ${spawnThinking}`);
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
