import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { cleanupTeamDir } from "./cleanup.js";
import {
	addTaskDependency,
	clearTasks,
	createTask,
	formatTaskLine,
	getTask,
	isTaskBlocked,
	listTasks,
	removeTaskDependency,
	unassignTasksForAgent,
	updateTask,
	type TeamTask,
} from "./task-store.js";
import { TeammateRpc } from "./teammate-rpc.js";
import { ensureTeamConfig, loadTeamConfig, setMemberStatus, upsertMember, type TeamConfig, type TeamMember } from "./team-config.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import { ensureWorktreeCwd } from "./worktree.js";
import { buildTeamsWidgetLines } from "./leader-widget.js";
import { pollLeaderInbox as pollLeaderInboxImpl } from "./leader-inbox.js";


type ContextMode = "fresh" | "branch";
type WorkspaceMode = "shared" | "worktree";

const TeamsActionSchema = StringEnum(["delegate"] as const, {
	description: "Teams tool action. Currently only 'delegate' is supported.",
	default: "delegate",
});

const TeamsContextModeSchema = StringEnum(["fresh", "branch"] as const, {
	description: "How to initialize teammate session context. 'branch' clones the leader session branch.",
	default: "fresh",
});

const TeamsWorkspaceModeSchema = StringEnum(["shared", "worktree"] as const, {
	description: "Workspace isolation mode. 'shared' matches Claude Teams; 'worktree' creates a git worktree per teammate.",
	default: "shared",
});

const TeamsDelegateTaskSchema = Type.Object({
	text: Type.String({ description: "Task / TODO text." }),
	assignee: Type.Optional(Type.String({ description: "Optional teammate name. If omitted, assigned round-robin." })),
});

const TeamsToolParams = Type.Object({
	action: Type.Optional(TeamsActionSchema),
	tasks: Type.Optional(Type.Array(TeamsDelegateTaskSchema, { description: "Tasks to delegate (action=delegate)." })),
	teammates: Type.Optional(
		Type.Array(Type.String(), { description: "Explicit teammate names to use/spawn. If omitted, uses existing or auto-generates." }),
	),
	maxTeammates: Type.Optional(
		Type.Integer({
			description: "If teammates is omitted and none exist, spawn up to this many.",
			default: 4,
			minimum: 1,
			maximum: 16,
		}),
	),
	contextMode: Type.Optional(TeamsContextModeSchema),
	workspaceMode: Type.Optional(TeamsWorkspaceModeSchema),
});

type TeamsToolParamsType = Static<typeof TeamsToolParams>;

function getTeamsExtensionEntryPath(): string | null {
	// In dev, teammates won't automatically have this extension unless it is installed or discoverable.
	// We try to load the same extension entry explicitly (and disable extension discovery to avoid duplicates).
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		const ts = path.join(dir, "index.ts");
		if (fs.existsSync(ts)) return ts;
		const js = path.join(dir, "index.js");
		if (fs.existsSync(js)) return js;
		return null;
	} catch {
		return null;
	}
}

function shellQuote(v: string): string {
	return "'" + v.replace(/'/g, `"'"'"'`) + "'";
}

function parseAssigneePrefix(text: string): { assignee?: string; text: string } {
	const m = text.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
	if (!m) return { text };
	return { assignee: m[1], text: m[2] };
}

function getTeamSessionsDir(teamDir: string): string {
	return path.join(teamDir, "sessions");
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

async function createSessionForTeammate(
	ctx: ExtensionContext,
	mode: ContextMode,
	teamSessionsDir: string,
): Promise<{ sessionFile?: string; note?: string; warnings: string[] }> {
	const warnings: string[] = [];
	await ensureDir(teamSessionsDir);

	if (mode === "fresh") {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "fresh", warnings };
	}

	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "branch(empty->fresh)", warnings };
	}

	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) {
		const sm = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: sm.getSessionFile(), note: "branch(in-memory->fresh)", warnings };
	}

	try {
		const sm = SessionManager.open(parentSessionFile, teamSessionsDir);
		const branched = sm.createBranchedSession(leafId);
		if (!branched) {
			const fallback = SessionManager.create(ctx.cwd, teamSessionsDir);
			return { sessionFile: fallback.getSessionFile(), note: "branch(failed->fresh)", warnings };
		}
		return { sessionFile: branched, note: "branch", warnings };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/Entry .* not found/i.test(msg)) {
			warnings.push(`Branch context missing (${msg}); falling back to fresh session.`);
		} else {
			warnings.push(`Branch context error (${msg}); falling back to fresh session.`);
		}
		const fallback = SessionManager.create(ctx.cwd, teamSessionsDir);
		return { sessionFile: fallback.getSessionFile(), note: "branch(error->fresh)", warnings };
	}
}

function taskAssignmentPayload(task: TeamTask, assignedBy: string) {
	return {
		type: "task_assignment",
		taskId: task.id,
		subject: task.subject,
		description: task.description,
		assignedBy,
		timestamp: new Date().toISOString(),
	};
}

// Message parsers are shared with the worker implementation.
export function runLeader(pi: ExtensionAPI): void {
	const teammates = new Map<string, TeammateRpc>();
	let currentCtx: ExtensionCommandContext | null = null;
	let currentTeamId: string | null = null;
	let tasks: TeamTask[] = [];
	let teamConfig: TeamConfig | null = null;
	const pendingPlanApprovals = new Map<string, { requestId: string; name: string; taskId?: string }>();
	let taskListId: string | null = process.env.PI_TEAMS_TASK_LIST_ID ?? null;

	let refreshTimer: NodeJS.Timeout | null = null;
	let inboxTimer: NodeJS.Timeout | null = null;
	let isStopping = false;
	let delegateMode = process.env.PI_TEAMS_DELEGATE_MODE === "1";

	const stopLoops = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (inboxTimer) clearInterval(inboxTimer);
		refreshTimer = null;
		inboxTimer = null;
	};

	const stopAllTeammates = async (ctx: ExtensionCommandContext, reason: string) => {
		if (teammates.size === 0) return;
		isStopping = true;
		try {
			for (const [name, t] of teammates.entries()) {
				await t.stop();
				// Claude-style: unassign non-completed tasks on exit.
				const teamId = ctx.sessionManager.getSessionId();
				const teamDir = getTeamDir(teamId);
				const effectiveTlId = taskListId ?? teamId;
				await unassignTasksForAgent(teamDir, effectiveTlId, name, reason);
				await setMemberStatus(teamDir, name, "offline", { meta: { stoppedReason: reason } });
			}
			teammates.clear();
		} finally {
			isStopping = false;
		}
	};

	const refreshTasks = async () => {
		if (!currentCtx || !currentTeamId) return;
		const teamDir = getTeamDir(currentTeamId);
		const effectiveTaskListId = taskListId ?? currentTeamId;

		const [nextTasks, cfg] = await Promise.all([listTasks(teamDir, effectiveTaskListId), loadTeamConfig(teamDir)]);
		tasks = nextTasks;
		teamConfig =
			cfg ??
			(await ensureTeamConfig(teamDir, {
				teamId: currentTeamId,
				taskListId: effectiveTaskListId,
				leadName: "team-lead",
			}));
	};

	const renderWidget = () => {
		if (!currentCtx) return;
		const lines = buildTeamsWidgetLines({
			delegateMode,
			tasks,
			teammates,
			teamConfig,
		});
		currentCtx.ui.setWidget("pi-teams", lines);
	};

	type SpawnTeammateResult =
		| {
				ok: true;
				name: string;
				mode: ContextMode;
				workspaceMode: WorkspaceMode;
				childCwd: string;
				note?: string;
				warnings: string[];
		  }
		| { ok: false; error: string };

	const spawnTeammate = async (
		ctx: ExtensionContext,
		opts: { name: string; mode?: ContextMode; workspaceMode?: WorkspaceMode; planRequired?: boolean },
	): Promise<SpawnTeammateResult> => {
		const warnings: string[] = [];
		const mode: ContextMode = opts.mode ?? "fresh";
		let workspaceMode: WorkspaceMode = opts.workspaceMode ?? "shared";

		const name = sanitizeName(opts.name);
		if (!name) return { ok: false, error: "Missing teammate name" };
		if (teammates.has(name)) return { ok: false, error: `Teammate already exists: ${name}` };

		const teamId = ctx.sessionManager.getSessionId();
		const teamDir = getTeamDir(teamId);
		const teamSessionsDir = getTeamSessionsDir(teamDir);
		const session = await createSessionForTeammate(ctx, mode, teamSessionsDir);
		const { sessionFile, note } = session;
		warnings.push(...session.warnings);

		const t = new TeammateRpc(name, sessionFile);
		teammates.set(name, t);
		renderWidget();

		// On crash/close, unassign tasks like Claude.
		const leaderSessionId = teamId;
		t.onClose((code) => {
			if (currentCtx?.sessionManager.getSessionId() !== leaderSessionId) return;
			void unassignTasksForAgent(teamDir, leaderSessionId, name, `Teammate '${name}' exited`).finally(() => {
				void refreshTasks().finally(renderWidget);
			});
			void setMemberStatus(teamDir, name, "offline", { meta: { exitCode: code ?? undefined } });
		});

		const builtInToolSet = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		const tools = (pi.getActiveTools() ?? []).filter((t) => builtInToolSet.has(t));
		const argsForChild: string[] = [];
		if (sessionFile) argsForChild.push("--session", sessionFile);
		argsForChild.push("--session-dir", teamSessionsDir);
		if (tools.length) argsForChild.push("--tools", tools.join(","));

		// Inherit model + thinking level to keep teammates consistent and avoid surprises.
		if (ctx.model) {
			argsForChild.push("--provider", ctx.model.provider, "--model", ctx.model.id);
		}
		argsForChild.push("--thinking", pi.getThinkingLevel());

		const teamsEntry = getTeamsExtensionEntryPath();
		if (teamsEntry) {
			argsForChild.push("--no-extensions", "-e", teamsEntry);
		}

		argsForChild.push(
			"--append-system-prompt",
			`You are teammate '${name}'. You collaborate with a team lead. Prefer working from the shared task list.\n`,
		);

		const autoClaim = (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1";

		let childCwd = ctx.cwd;
		if (workspaceMode === "worktree") {
			const res = await ensureWorktreeCwd({ leaderCwd: ctx.cwd, teamDir, teamId, agentName: name });
			childCwd = res.cwd;
			workspaceMode = res.mode;
			warnings.push(...res.warnings);
		}

		try {
			await t.start({
				cwd: childCwd,
				env: {
					PI_TEAMS_WORKER: "1",
					PI_TEAMS_TEAM_ID: teamId,
					PI_TEAMS_TASK_LIST_ID: taskListId ?? teamId,
					PI_TEAMS_AGENT_NAME: name,
					PI_TEAMS_LEAD_NAME: "team-lead",
					PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0",
					...(opts.planRequired ? { PI_TEAMS_PLAN_REQUIRED: "1" } : {}),
				},
				args: argsForChild,
			});
		} catch (err) {
			teammates.delete(name);
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		const sessionName = `pi agent teams - comrade ${name}`;

		// Leader-driven session naming (so teammates are easy to spot in /resume).
		try {
			await t.setSessionName(sessionName);
		} catch (err) {
			warnings.push(`Failed to set session name for ${name}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Also send via mailbox so non-RPC/manual workers can be named the same way.
		try {
			const ts = new Date().toISOString();
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
				from: "team-lead",
				text: JSON.stringify({ type: "set_session_name", name: sessionName, from: "team-lead", timestamp: ts }),
				timestamp: ts,
			});
		} catch {
			// ignore
		}

		await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName: "team-lead" });
		await upsertMember(teamDir, {
			name,
			role: "worker",
			status: "online",
			cwd: childCwd,
			sessionFile,
			meta: { workspaceMode, sessionName },
		});

		await refreshTasks();
		renderWidget();

		return { ok: true, name, mode, workspaceMode, childCwd, note, warnings };
	};

	const pollLeaderInbox = async () => {
		if (!currentCtx || !currentTeamId) return;
		const teamDir = getTeamDir(currentTeamId);
		const effectiveTaskListId = taskListId ?? currentTeamId;
		await pollLeaderInboxImpl({
			ctx: currentCtx,
			teamId: currentTeamId,
			teamDir,
			taskListId: effectiveTaskListId,
			pendingPlanApprovals,
		});
	};

	pi.on("tool_call", (event, _ctx) => {
		if (!delegateMode) return;
		const blockedTools = new Set(["bash", "edit", "write"]);
		if (blockedTools.has(event.name)) {
			return { block: true, reason: "Delegate mode is active — use teammates for implementation." };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx as ExtensionCommandContext;
		currentTeamId = currentCtx.sessionManager.getSessionId();
		if (!taskListId) taskListId = currentTeamId;

		// Claude-style: a persisted team config file.
		await ensureTeamConfig(getTeamDir(currentTeamId), {
			teamId: currentTeamId,
			taskListId: taskListId,
			leadName: "team-lead",
		});

		await refreshTasks();
		renderWidget();

		stopLoops();
		refreshTimer = setInterval(async () => {
			if (isStopping) return;
			await refreshTasks();
			renderWidget();
		}, 1000);

		inboxTimer = setInterval(async () => {
			if (isStopping) return;
			await pollLeaderInbox();
		}, 700);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (currentCtx) {
			await stopAllTeammates(currentCtx, "Stopped due to leader session switch");
		}
		stopLoops();

		currentCtx = ctx as ExtensionCommandContext;
		currentTeamId = currentCtx.sessionManager.getSessionId();
		if (!taskListId) taskListId = currentTeamId;

		await ensureTeamConfig(getTeamDir(currentTeamId), {
			teamId: currentTeamId,
			taskListId: taskListId,
			leadName: "team-lead",
		});

		await refreshTasks();
		renderWidget();

		// Restart background refresh/poll loops for the new session.
		refreshTimer = setInterval(async () => {
			if (isStopping) return;
			await refreshTasks();
			renderWidget();
		}, 1000);

		inboxTimer = setInterval(async () => {
			if (isStopping) return;
			await pollLeaderInbox();
		}, 700);
	});

	pi.on("session_shutdown", async () => {
		if (!currentCtx) return;
		stopLoops();
		await stopAllTeammates(currentCtx, "Stopped due to leader shutdown");
	});

	pi.registerTool({
		name: "teams",
		label: "Teams",
		description: [
			"Spawn teammate agents and delegate tasks. Each teammate is a child Pi process that executes work autonomously and reports back.",
			"Provide a list of tasks with optional assignees; teammates are spawned automatically and assigned round-robin if unspecified.",
			"Options: contextMode=branch (clone session context), workspaceMode=worktree (git worktree isolation).",
			"For governance, the user can run /team delegate on (leader restricted to coordination) or /team spawn <name> plan (worker needs plan approval).",
		].join(" "),
		parameters: TeamsToolParams,

		async execute(_toolCallId, params: TeamsToolParamsType, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action ?? "delegate";
			if (action !== "delegate") {
				return {
					content: [{ type: "text", text: `Unsupported action: ${String(action)}` }],
					details: { action },
				};
			}

			const inputTasks = params.tasks ?? [];
			if (inputTasks.length === 0) {
				return {
					content: [
						{ type: "text", text: "No tasks provided. Provide tasks: [{text, assignee?}, ...]" },
					],
					details: { action },
				};
			}

			const contextMode: ContextMode = params.contextMode === "branch" ? "branch" : "fresh";
			const requestedWorkspaceMode: WorkspaceMode = params.workspaceMode === "worktree" ? "worktree" : "shared";

			const teamId = ctx.sessionManager.getSessionId();
			const teamDir = getTeamDir(teamId);
			await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName: "team-lead" });

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
				teammateNames = Array.from({ length: count }, (_, i) => `agent${i + 1}`);
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
				const subject = description.split("\n")[0].slice(0, 120);
				const effectiveTlId = taskListId ?? teamId;
				const task = await createTask(teamDir, effectiveTlId, { subject, description, owner: assignee });

				await writeToMailbox(teamDir, effectiveTlId, assignee, {
					from: "team-lead",
					text: JSON.stringify(taskAssignmentPayload(task, "team-lead")),
					timestamp: new Date().toISOString(),
				});

				assignments.push({ taskId: task.id, assignee, subject });
			}

			// Best-effort widget refresh
			void refreshTasks().finally(renderWidget);

			const lines: string[] = [];
			if (spawned.length) lines.push(`Spawned: ${spawned.join(", ")}`);
			lines.push(`Delegated ${assignments.length} task(s):`);
			for (const a of assignments) {
				lines.push(`- #${a.taskId} → ${a.assignee}: ${a.subject}`);
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

	pi.registerCommand("team", {
		description: "Teams: spawn teammates + coordinate via Claude-like task list",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			currentTeamId = ctx.sessionManager.getSessionId();

			const [sub, ...rest] = args.trim().split(" ");
			if (!sub || sub === "help") {
				ctx.ui.notify(
					[
						"Usage:",
						"  /team id",
						"  /team env <name>",
						"  /team spawn <name> [fresh|branch] [shared|worktree] [plan]",
						"  /team send <name> <msg...>",
						"  /team dm <name> <msg...>",
						"  /team broadcast <msg...>",
						"  /team steer <name> <msg...>",
						"  /team stop <name> [reason...]",
						"  /team kill <name>",
						"  /team shutdown",
						"  /team shutdown <name> [reason...]",
						"  /team delegate [on|off]",
						"  /team plan approve <name>",
						"  /team plan reject <name> [feedback...]",
						"  /team cleanup [--force]",
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
					].join("\n"),
					"info",
				);
				return;
			}

			switch (sub) {
				case "list": {
					await refreshTasks();

					const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
					const cfgByName = new Map<string, TeamMember>();
					for (const m of cfgWorkers) cfgByName.set(m.name, m);

					const names = new Set<string>();
					for (const name of teammates.keys()) names.add(name);
					for (const name of cfgByName.keys()) names.add(name);

					if (names.size === 0) {
						ctx.ui.notify("No teammates", "info");
						renderWidget();
						return;
					}

					const lines: string[] = [];
					for (const name of Array.from(names).sort()) {
						const rpc = teammates.get(name);
						const cfg = cfgByName.get(name);
						const status = rpc ? rpc.status : cfg?.status ?? "offline";
						const kind = rpc ? "rpc" : cfg ? "manual" : "unknown";
						lines.push(`${name}: ${status} (${kind})`);
					}

					ctx.ui.notify(lines.join("\n"), "info");
					renderWidget();
					return;
				}

				case "id": {
					const teamId = ctx.sessionManager.getSessionId();
					const effectiveTlId = taskListId ?? teamId;
					const leadName = "team-lead";
					const teamsRoot = getTeamsRootDir();
					const teamDir = getTeamDir(teamId);

					ctx.ui.notify(
						[
							`teamId: ${teamId}`,
							`taskListId: ${effectiveTlId}`,
							`leadName: ${leadName}`,
							`teamsRoot: ${teamsRoot}`,
							`teamDir: ${teamDir}`,
						].join("\n"),
						"info",
					);
					return;
				}

				case "env": {
					const nameRaw = rest[0];
					if (!nameRaw) {
						ctx.ui.notify("Usage: /team env <name>", "error");
						return;
					}

					const name = sanitizeName(nameRaw);
					const teamId = ctx.sessionManager.getSessionId();
					const effectiveTlId = taskListId ?? teamId;
					const leadName = "team-lead";
					const teamsRoot = getTeamsRootDir();
					const teamDir = getTeamDir(teamId);
					const autoClaim = (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1" ? "1" : "0";

					const teamsEntry = getTeamsExtensionEntryPath();
					const piCmd = teamsEntry ? `pi --no-extensions -e ${shellQuote(teamsEntry)}` : "pi";

					const env: Record<string, string> = {
						PI_TEAMS_ROOT_DIR: teamsRoot,
						PI_TEAMS_WORKER: "1",
						PI_TEAMS_TEAM_ID: teamId,
						PI_TEAMS_TASK_LIST_ID: effectiveTlId,
						PI_TEAMS_AGENT_NAME: name,
						PI_TEAMS_LEAD_NAME: leadName,
						PI_TEAMS_AUTO_CLAIM: autoClaim,
					};

					const exportLines = Object.entries(env)
						.map(([k, v]) => `export ${k}=${shellQuote(v)}`)
						.join("\n");

					const oneLiner = Object.entries(env)
						.map(([k, v]) => `${k}=${shellQuote(v)}`)
						.join(" ")
						.concat(` ${piCmd}`);

					ctx.ui.notify(
						[
							`teamId: ${teamId}`,
							`taskListId: ${effectiveTlId}`,
							`leadName: ${leadName}`,
							`teamsRoot: ${teamsRoot}`,
							`teamDir: ${teamDir}`,
							"",
							"Env (copy/paste):",
							exportLines,
							"",
							"Run:",
							oneLiner,
						].join("\n"),
						"info",
					);
					return;
				}

				case "cleanup": {
					const flags = rest.filter((a) => a.startsWith("--"));
					const argsOnly = rest.filter((a) => !a.startsWith("--"));
					const force = flags.includes("--force");

					const unknownFlags = flags.filter((f) => f !== "--force");
					if (unknownFlags.length) {
						ctx.ui.notify(`Unknown flag(s): ${unknownFlags.join(", ")}`, "error");
						return;
					}
					if (argsOnly.length) {
						ctx.ui.notify("Usage: /team cleanup [--force]", "error");
						return;
					}

					const teamId = ctx.sessionManager.getSessionId();
					const teamsRoot = getTeamsRootDir();
					const teamDir = getTeamDir(teamId);

					if (!force && teammates.size > 0) {
						ctx.ui.notify(
							`Refusing to cleanup while ${teammates.size} RPC teammate(s) are running. Stop them first or use --force.`,
							"error",
						);
						return;
					}

					await refreshTasks();
					const inProgress = tasks.filter((t) => t.status === "in_progress");
					if (!force && inProgress.length > 0) {
						ctx.ui.notify(
							`Refusing to cleanup with ${inProgress.length} in_progress task(s). Complete/unassign them first or use --force.`,
							"error",
						);
						return;
					}

					if (!force) {
						// Only prompt in interactive TTY mode. In RPC mode, confirm() would require
						// the host to send extension_ui_response messages.
						if (process.stdout.isTTY && process.stdin.isTTY) {
							const ok = await ctx.ui.confirm(
								"Cleanup team",
								[
									"Delete ALL team artifacts for this session?",
									"",
									`teamId: ${teamId}`,
									`teamDir: ${teamDir}`,
									`tasks: ${tasks.length} (in_progress: ${inProgress.length})`,
								].join("\n"),
							);
							if (!ok) return;
						} else {
							ctx.ui.notify("Refusing to cleanup in non-interactive mode without --force", "error");
							return;
						}
					}

					try {
						await cleanupTeamDir(teamsRoot, teamDir);
					} catch (err) {
						ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
						return;
					}

					ctx.ui.notify(`Cleaned up team directory: ${teamDir}`, "warning");
					await refreshTasks();
					renderWidget();
					return;
				}

				case "delegate": {
					const arg = rest[0];
					if (arg === "on") delegateMode = true;
					else if (arg === "off") delegateMode = false;
					else delegateMode = !delegateMode;
					ctx.ui.notify(`Delegate mode ${delegateMode ? "ON" : "OFF"}`, "info");
					renderWidget();
					return;
				}

				case "shutdown": {
					const nameRaw = rest[0];

					// /team shutdown <name> [reason...] = request graceful worker shutdown via mailbox
					if (nameRaw) {
						const name = sanitizeName(nameRaw);
						const reason = rest.slice(1).join(" ").trim() || undefined;

						const teamId = ctx.sessionManager.getSessionId();
						const teamDir = getTeamDir(teamId);

						const requestId = randomUUID();
						const ts = new Date().toISOString();
						const payload: {
							type: "shutdown_request";
							requestId: string;
							from: "team-lead";
							timestamp: string;
							reason?: string;
						} = {
							type: "shutdown_request",
							requestId,
							from: "team-lead",
							timestamp: ts,
							...(reason ? { reason } : {}),
						};

						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: "team-lead",
							text: JSON.stringify(payload),
							timestamp: ts,
						});

						// Best-effort: record in member metadata (if present).
						void setMemberStatus(teamDir, name, "online", {
							meta: {
								shutdownRequestedAt: ts,
								shutdownRequestId: requestId,
								...(reason ? { shutdownReason: reason } : {}),
							},
						});

						ctx.ui.notify(`Shutdown requested for ${name}`, "info");

						// Optional fallback for RPC teammates: force stop if it doesn't exit.
						const t = teammates.get(name);
						if (t) {
							setTimeout(() => {
								if (currentCtx?.sessionManager.getSessionId() !== teamId) return;
								if (t.status === "stopped" || t.status === "error") return;
								void (async () => {
									try {
										await t.stop();
										await setMemberStatus(teamDir, name, "offline", {
											meta: { shutdownFallback: true, shutdownRequestId: requestId },
										});
										currentCtx?.ui.notify(`Shutdown timeout; killed ${name}`, "warning");
									} catch {
										// ignore
									}
								})();
							}, 10_000);
						}

						return;
					}

					// /team shutdown (no args) = shutdown leader + all teammates
					// Only prompt in interactive TTY mode. In RPC mode, confirm() would require
					// the host to send extension_ui_response messages.
					if (process.stdout.isTTY && process.stdin.isTTY) {
						const ok = await ctx.ui.confirm("Shutdown", "Exit pi and stop all teammates?");
						if (!ok) return;
					}
					// In RPC mode, shutdown is deferred until the next input line is handled.
					// Teammates are stopped in the session_shutdown handler.
					ctx.ui.notify("Shutdown requested", "info");
					ctx.shutdown();
					return;
				}

				case "spawn": {
					const nameRaw = rest[0];
					const spawnArgs = rest.slice(1);

					let mode: ContextMode = "fresh";
					let workspaceMode: WorkspaceMode = "shared";
					let planRequired = false;
					for (const a of spawnArgs) {
						if (a === "fresh" || a === "branch") mode = a;
						if (a === "shared" || a === "worktree") workspaceMode = a;
						if (a === "plan") planRequired = true;
					}

					if (!nameRaw) {
						ctx.ui.notify("Usage: /team spawn <name> [fresh|branch] [shared|worktree] [plan]", "error");
						return;
					}

					const res = await spawnTeammate(ctx, { name: nameRaw, mode, workspaceMode, planRequired });
					if (!res.ok) {
						ctx.ui.notify(res.error, "error");
						return;
					}

					for (const w of res.warnings) ctx.ui.notify(w, "warning");
					ctx.ui.notify(
						`Spawned teammate '${res.name}' (${res.mode}${res.note ? ", " + res.note : ""} • ${res.workspaceMode})`,
						"info",
					);
					return;
				}

				case "send": {
					const nameRaw = rest[0];
					const msg = rest.slice(1).join(" ").trim();
					if (!nameRaw || !msg) {
						ctx.ui.notify("Usage: /team send <name> <msg...>", "error");
						return;
					}
					const name = sanitizeName(nameRaw);
					const t = teammates.get(name);
					if (!t) {
						ctx.ui.notify(`Unknown teammate: ${name}`, "error");
						return;
					}
					if (t.status === "streaming") await t.followUp(msg);
					else await t.prompt(msg);
					ctx.ui.notify(`Sent to ${name}`, "info");
					renderWidget();
					return;
				}

				case "steer": {
					const nameRaw = rest[0];
					const msg = rest.slice(1).join(" ").trim();
					if (!nameRaw || !msg) {
						ctx.ui.notify("Usage: /team steer <name> <msg...>", "error");
						return;
					}
					const name = sanitizeName(nameRaw);
					const t = teammates.get(name);
					if (!t) {
						ctx.ui.notify(`Unknown teammate: ${name}`, "error");
						return;
					}
					await t.steer(msg);
					ctx.ui.notify(`Steering sent to ${name}`, "info");
					renderWidget();
					return;
				}

				case "stop": {
					const nameRaw = rest[0];
					const reason = rest.slice(1).join(" ").trim();
					if (!nameRaw) {
						ctx.ui.notify("Usage: /team stop <name> [reason...]", "error");
						return;
					}
					const name = sanitizeName(nameRaw);

					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);

					// Best-effort: include current in-progress task id (if any).
					await refreshTasks();
					const active = tasks.find((x) => x.owner === name && x.status === "in_progress");
					const taskId = active?.id;

					const ts = new Date().toISOString();
					await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
						from: "team-lead",
						text: JSON.stringify({
							type: "abort_request",
							requestId: randomUUID(),
							from: "team-lead",
							taskId,
							reason: reason || undefined,
							timestamp: ts,
						}),
						timestamp: ts,
					});

					const t = teammates.get(name);
					if (t) {
						// Fast-path for RPC teammates.
						await t.abort();
					}

					ctx.ui.notify(
						`Abort requested for ${name}${taskId ? ` (task #${taskId})` : ""}${t ? "" : " (mailbox only)"}`,
						"warning",
					);
					renderWidget();
					return;
				}

				case "kill": {
					const nameRaw = rest[0];
					if (!nameRaw) {
						ctx.ui.notify("Usage: /team kill <name>", "error");
						return;
					}
					const name = sanitizeName(nameRaw);
					const t = teammates.get(name);
					if (!t) {
						ctx.ui.notify(`Unknown teammate: ${name}`, "error");
						return;
					}

					await t.stop();
					teammates.delete(name);

					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);
					const effectiveTlId = taskListId ?? teamId;
					await unassignTasksForAgent(teamDir, effectiveTlId, name, `Killed teammate '${name}'`);
					await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });

					ctx.ui.notify(`Killed teammate ${name}`, "warning");
					await refreshTasks();
					renderWidget();
					return;
				}

				case "dm": {
					const nameRaw = rest[0];
					const msg = rest.slice(1).join(" ").trim();
					if (!nameRaw || !msg) {
						ctx.ui.notify("Usage: /team dm <name> <msg...>", "error");
						return;
					}
					const name = sanitizeName(nameRaw);
					const teamId = ctx.sessionManager.getSessionId();
					await writeToMailbox(getTeamDir(teamId), TEAM_MAILBOX_NS, name, {
						from: "team-lead",
						text: msg,
						timestamp: new Date().toISOString(),
					});
					ctx.ui.notify(`DM queued for ${name}`, "info");
					return;
				}

				case "broadcast": {
					const msg = rest.join(" ").trim();
					if (!msg) {
						ctx.ui.notify("Usage: /team broadcast <msg...>", "error");
						return;
					}

					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);
					const leadName = "team-lead";
					const cfg = await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName });

					const recipients = new Set<string>();
					for (const m of cfg.members) {
						if (m.role === "worker") recipients.add(m.name);
					}
					for (const name of teammates.keys()) recipients.add(name);

					// Include task owners (helps reach manual tmux workers not tracked as RPC teammates).
					await refreshTasks();
					for (const t of tasks) {
						if (t.owner && t.owner !== leadName) recipients.add(t.owner);
					}

					const names = Array.from(recipients).sort();
					if (names.length === 0) {
						ctx.ui.notify("No teammates to broadcast to", "warning");
						return;
					}

					const ts = new Date().toISOString();
					await Promise.all(
						names.map((name) =>
							writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
								from: "team-lead",
								text: msg,
								timestamp: ts,
							}),
						),
					);

					ctx.ui.notify(`Broadcast queued for ${names.length} teammate(s): ${names.join(", ")}`, "info");
					return;
				}

				case "task": {
					const [taskSub, ...taskRest] = rest;
					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);
					const effectiveTlId = taskListId ?? teamId;

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
							const subject = description.split("\n")[0].slice(0, 120);

							const task = await createTask(teamDir, effectiveTlId, { subject, description, owner });

							if (owner) {
								const payload = taskAssignmentPayload(task, "team-lead");
								await writeToMailbox(teamDir, effectiveTlId, owner, {
									from: "team-lead",
									text: JSON.stringify(payload),
									timestamp: new Date().toISOString(),
								});
							}

							ctx.ui.notify(`Created task #${task.id}${owner ? ` (assigned to ${owner})` : ""}`, "info");
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
								from: "team-lead",
								text: JSON.stringify(taskAssignmentPayload(updated, "team-lead")),
								timestamp: new Date().toISOString(),
							});

							ctx.ui.notify(`Assigned task #${updated.id} to ${owner}`, "info");
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

							const result = typeof task.metadata?.result === "string" ? (task.metadata.result as string) : undefined;
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
							const toDelete =
								mode === "all" ? tasks.length : tasks.filter((t) => t.status === "completed").length;

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
								ctx.ui.notify(
									`Cleared ${deleted} task(s) (${mode}) with ${res.errors.length} error(s)`,
									"warning",
								);
								const preview = res.errors
									.slice(0, 8)
									.map((e) => `- ${path.basename(e.file)}: ${e.error}`)
									.join("\n");
								ctx.ui.notify(`Errors:\n${preview}${res.errors.length > 8 ? `\n... +${res.errors.length - 8} more` : ""}`,
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
							taskListId = newId;
							await ensureTeamConfig(teamDir, { teamId, taskListId: newId, leadName: "team-lead" });
							ctx.ui.notify(`Task list ID set to: ${taskListId}`, "info");
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

				case "plan": {
					const [planSub, ...planRest] = rest;
					if (!planSub || planSub === "help") {
						ctx.ui.notify(
							[
								"Usage:",
								"  /team plan approve <name>",
								"  /team plan reject <name> [feedback...]",
							].join("\n"),
							"info",
						);
						return;
					}

					if (planSub === "approve") {
						const nameRaw = planRest[0];
						if (!nameRaw) {
							ctx.ui.notify("Usage: /team plan approve <name>", "error");
							return;
						}
						const name = sanitizeName(nameRaw);
						const pending = pendingPlanApprovals.get(name);
						if (!pending) {
							ctx.ui.notify(`No pending plan approval for ${name}`, "error");
							return;
						}

						const teamId = ctx.sessionManager.getSessionId();
						const teamDir = getTeamDir(teamId);
						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: "team-lead",
							text: JSON.stringify({
								type: "plan_approved",
								requestId: pending.requestId,
								from: "team-lead",
								timestamp: ts,
							}),
							timestamp: ts,
						});
						pendingPlanApprovals.delete(name);
						ctx.ui.notify(`Approved plan for ${name}`, "info");
						return;
					}

					if (planSub === "reject") {
						const nameRaw = planRest[0];
						if (!nameRaw) {
							ctx.ui.notify("Usage: /team plan reject <name> [feedback...]", "error");
							return;
						}
						const name = sanitizeName(nameRaw);
						const pending = pendingPlanApprovals.get(name);
						if (!pending) {
							ctx.ui.notify(`No pending plan approval for ${name}`, "error");
							return;
						}

						const feedback = planRest.slice(1).join(" ").trim() || "Plan rejected";
						const teamId = ctx.sessionManager.getSessionId();
						const teamDir = getTeamDir(teamId);
						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: "team-lead",
							text: JSON.stringify({
								type: "plan_rejected",
								requestId: pending.requestId,
								from: "team-lead",
								feedback,
								timestamp: ts,
							}),
							timestamp: ts,
						});
						pendingPlanApprovals.delete(name);
						ctx.ui.notify(`Rejected plan for ${name}: ${feedback}`, "info");
						return;
					}

					ctx.ui.notify(`Unknown plan subcommand: ${planSub}`, "error");
					return;
				}

				default: {
					ctx.ui.notify(`Unknown subcommand: ${sub}`, "error");
					return;
				}
			}
		},
	});
}
