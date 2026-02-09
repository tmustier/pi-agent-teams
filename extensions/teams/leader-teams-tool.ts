import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { pickAgentNames, pickComradeNames, sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import { taskAssignmentPayload } from "./protocol.js";
import { ensureTeamConfig } from "./team-config.js";
import { getTeamsStyleFromEnv, type TeamsStyle, formatMemberDisplayName } from "./teams-style.js";
import { createTask } from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { ContextMode, WorkspaceMode, SpawnTeammateFn } from "./spawn-types.js";

type TeamsToolDelegateTask = { text: string; assignee?: string };

const TeamsActionSchema = StringEnum(["delegate"] as const, {
	description: "Teams tool action. Currently only 'delegate' is supported.",
	default: "delegate",
});

const TeamsContextModeSchema = StringEnum(["fresh", "branch"] as const, {
	description: "How to initialize comrade session context. 'branch' clones the leader session branch.",
	default: "fresh",
});

const TeamsWorkspaceModeSchema = StringEnum(["shared", "worktree"] as const, {
	description: "Workspace isolation mode. 'shared' matches Claude Teams; 'worktree' creates a git worktree per comrade.",
	default: "shared",
});

const TeamsDelegateTaskSchema = Type.Object({
	text: Type.String({ description: "Task / TODO text." }),
	assignee: Type.Optional(Type.String({ description: "Optional comrade name. If omitted, assigned round-robin." })),
});

const TeamsToolParamsSchema = Type.Object({
	action: Type.Optional(TeamsActionSchema),
	tasks: Type.Optional(Type.Array(TeamsDelegateTaskSchema, { description: "Tasks to delegate (action=delegate)." })),
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
});

type TeamsToolParamsType = Static<typeof TeamsToolParamsSchema>;

export function registerTeamsTool(opts: {
	pi: ExtensionAPI;
	teammates: Map<string, TeammateRpc>;
	spawnTeammate: SpawnTeammateFn;
	getTaskListId: () => string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): void {
	const { pi, teammates, spawnTeammate, getTaskListId, refreshTasks, renderWidget } = opts;

	pi.registerTool({
		name: "teams",
		label: "Teams",
		description: [
			"Spawn comrade agents and delegate tasks. Each comrade is a child Pi process that executes work autonomously and reports back.",
			"Provide a list of tasks with optional assignees; comrades are spawned automatically and assigned round-robin if unspecified.",
			"Options: contextMode=branch (clone session context), workspaceMode=worktree (git worktree isolation).",
			"For governance, the user can run /team delegate on (leader restricted to coordination) or /team spawn <name> plan (worker needs plan approval).",
		].join(" "),
		parameters: TeamsToolParamsSchema,

		async execute(_toolCallId, params: TeamsToolParamsType, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action ?? "delegate";
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

			const teamId = ctx.sessionManager.getSessionId();
			const teamDir = getTeamDir(teamId);
			const taskListId = getTaskListId();
			const cfg = await ensureTeamConfig(teamDir, {
				teamId,
				taskListId: taskListId ?? teamId,
				leadName: "team-lead",
				style: getTeamsStyleFromEnv(),
			});
			const style: TeamsStyle = cfg.style ?? getTeamsStyleFromEnv();

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
				teammateNames = style === "soviet" ? pickComradeNames(count, taken) : pickAgentNames(count, taken);
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
				});
				if (!res.ok) {
					warnings.push(`Failed to spawn '${name}': ${res.error}`);
					continue;
				}
				spawned.push(res.name);
				warnings.push(...res.warnings);
			}

			// Assign tasks (explicit assignee wins; otherwise round-robin)
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

				// Ensure assignee exists
				if (!teammates.has(assignee)) {
					const res = await spawnTeammate(ctx, {
						name: assignee,
						mode: contextMode,
						workspaceMode: requestedWorkspaceMode,
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
				const effectiveTlId = taskListId ?? teamId;
				const task = await createTask(teamDir, effectiveTlId, { subject, description, owner: assignee });

				await writeToMailbox(teamDir, effectiveTlId, assignee, {
					from: cfg.leadName,
					text: JSON.stringify(taskAssignmentPayload(task, cfg.leadName)),
					timestamp: new Date().toISOString(),
				});

				assignments.push({ taskId: task.id, assignee, subject });
			}

			// Best-effort widget refresh
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
					contextMode,
					workspaceMode: requestedWorkspaceMode,
					spawned,
					assignments,
					warnings,
				},
			};
		},
	});
}
