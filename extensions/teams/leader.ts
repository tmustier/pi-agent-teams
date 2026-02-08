import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { listTasks, unassignTasksForAgent, type TeamTask } from "./task-store.js";
import { TeammateRpc } from "./teammate-rpc.js";
import { ensureTeamConfig, loadTeamConfig, setMemberStatus, upsertMember, type TeamConfig } from "./team-config.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import { ensureWorktreeCwd } from "./worktree.js";
import { ActivityTracker } from "./activity-tracker.js";
import { openInteractiveWidget } from "./teams-panel.js";
import { createTeamsWidget } from "./teams-widget.js";
import { getTeamsStyleFromEnv, type TeamsStyle, formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import { pollLeaderInbox as pollLeaderInboxImpl } from "./leader-inbox.js";
import { handleTeamTaskCommand } from "./leader-task-commands.js";
import { handleTeamPlanCommand } from "./leader-plan-commands.js";
import { handleTeamSpawnCommand } from "./leader-spawn-command.js";
import { registerTeamsTool } from "./leader-teams-tool.js";
import {
	handleTeamBroadcastCommand,
	handleTeamDmCommand,
	handleTeamSendCommand,
	handleTeamSteerCommand,
} from "./leader-messaging-commands.js";
import { handleTeamEnvCommand, handleTeamIdCommand, handleTeamListCommand } from "./leader-info-commands.js";
import {
	handleTeamCleanupCommand,
	handleTeamDelegateCommand,
	handleTeamKillCommand,
	handleTeamShutdownCommand,
	handleTeamStopCommand,
	handleTeamStyleCommand,
} from "./leader-lifecycle-commands.js";


type ContextMode = "fresh" | "branch";
type WorkspaceMode = "shared" | "worktree";

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
	const assignee = m[1];
	const rest = m[2];
	if (!assignee || !rest) return { text };
	return { assignee, text: rest };
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
	const tracker = new ActivityTracker();
	const teammateEventUnsubs = new Map<string, () => void>();
	let currentCtx: ExtensionContext | null = null;
	let currentTeamId: string | null = null;
	let tasks: TeamTask[] = [];
	let teamConfig: TeamConfig | null = null;
	const pendingPlanApprovals = new Map<string, { requestId: string; name: string; taskId?: string }>();
	// Task list namespace. By default we keep it aligned with the current session id.
	// (Do NOT read PI_TEAMS_TASK_LIST_ID for the leader; that env var is intended for workers
	// and can easily be set globally, which makes the leader "lose" its tasks.)
	let taskListId: string | null = null;

	let refreshTimer: NodeJS.Timeout | null = null;
	let inboxTimer: NodeJS.Timeout | null = null;
	let refreshInFlight = false;
	let inboxInFlight = false;
	let isStopping = false;
	let delegateMode = process.env.PI_TEAMS_DELEGATE_MODE === "1";
	let style: TeamsStyle = getTeamsStyleFromEnv();

	const stopLoops = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (inboxTimer) clearInterval(inboxTimer);
		refreshTimer = null;
		inboxTimer = null;
	};

	const stopAllTeammates = async (ctx: ExtensionContext, reason: string) => {
		if (teammates.size === 0) return;
		isStopping = true;
		try {
			for (const [name, t] of teammates.entries()) {
				try {
					teammateEventUnsubs.get(name)?.();
				} catch {
					// ignore
				}
				teammateEventUnsubs.delete(name);
				tracker.reset(name);

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

	const widgetFactory = createTeamsWidget({
		getTeammates: () => teammates,
		getTracker: () => tracker,
		getTasks: () => tasks,
		getTeamConfig: () => teamConfig,
		getStyle: () => style,
		isDelegateMode: () => delegateMode,
	});

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
				style,
			}));
		style = teamConfig.style ?? style;
	};

	const renderWidget = () => {
		if (!currentCtx) return;
		// Component widget (more informative + styled). Re-setting it is also our "refresh" trigger.
		currentCtx.ui.setWidget("pi-teams", widgetFactory);
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
		if (!name) return { ok: false, error: "Missing comrade name" };
		if (teammates.has(name)) {
			const strings = getTeamsStrings(style);
			return { ok: false, error: `${formatMemberDisplayName(style, name)} already exists (${strings.teamNoun})` };
		}

		const teamId = ctx.sessionManager.getSessionId();
		const teamDir = getTeamDir(teamId);
		const teamSessionsDir = getTeamSessionsDir(teamDir);
		const session = await createSessionForTeammate(ctx, mode, teamSessionsDir);
		const { sessionFile, note } = session;
		warnings.push(...session.warnings);

		const t = new TeammateRpc(name, sessionFile);
		teammates.set(name, t);
		// Track teammate activity for the widget/panel.
		const unsub = t.onEvent((ev) => tracker.handleEvent(name, ev));
		teammateEventUnsubs.set(name, unsub);
		renderWidget();

		// On crash/close, unassign tasks like Claude.
		const leaderSessionId = teamId;
		t.onClose((code) => {
			try {
				teammateEventUnsubs.get(name)?.();
			} catch {
				// ignore
			}
			teammateEventUnsubs.delete(name);
			tracker.reset(name);

			if (currentCtx?.sessionManager.getSessionId() !== leaderSessionId) return;
			const effectiveTlId = taskListId ?? leaderSessionId;
			void unassignTasksForAgent(
				teamDir,
				effectiveTlId,
				name,
				`${formatMemberDisplayName(style, name)} ${getTeamsStrings(style).leftVerb}`,
			).finally(() => {
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

		const systemAppend =
			style === "soviet"
				? `You are comrade '${name}'. You collaborate with the chairman. Prefer working from the shared task list.\n`
				: `You are teammate '${name}'. You collaborate with the team leader. Prefer working from the shared task list.\n`;
		argsForChild.push("--append-system-prompt", systemAppend);

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
					PI_TEAMS_STYLE: style,
					PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0",
					...(opts.planRequired ? { PI_TEAMS_PLAN_REQUIRED: "1" } : {}),
				},
				args: argsForChild,
			});
		} catch (err) {
			teammates.delete(name);
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		const strings = getTeamsStrings(style);
		const sessionName = `pi agent teams - ${strings.memberTitle.toLowerCase()} ${name}`;

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

		await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName: "team-lead", style });
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
			leadName: teamConfig?.leadName ?? "team-lead",
			style,
			pendingPlanApprovals,
		});
	};

	pi.on("tool_call", (event, _ctx) => {
		if (!delegateMode) return;
		const blockedTools = new Set(["bash", "edit", "write"]);
		if (blockedTools.has(event.toolName)) {
			return { block: true, reason: "Delegate mode is active - use comrades for implementation." };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		currentTeamId = currentCtx.sessionManager.getSessionId();
		// Keep the task list aligned with the active session. If you want a shared namespace,
		// use `/team task use <taskListId>` after switching.
		taskListId = currentTeamId;

		// Claude-style: a persisted team config file.
		await ensureTeamConfig(getTeamDir(currentTeamId), {
			teamId: currentTeamId,
			taskListId: taskListId,
			leadName: "team-lead",
			style,
		});

		await refreshTasks();
		renderWidget();

		stopLoops();
		refreshTimer = setInterval(async () => {
			if (isStopping) return;
			if (refreshInFlight) return;
			refreshInFlight = true;
			try {
				await refreshTasks();
				renderWidget();
			} finally {
				refreshInFlight = false;
			}
		}, 1000);

		inboxTimer = setInterval(async () => {
			if (isStopping) return;
			if (inboxInFlight) return;
			inboxInFlight = true;
			try {
				await pollLeaderInbox();
			} finally {
				inboxInFlight = false;
			}
		}, 700);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (currentCtx) {
			const strings = getTeamsStrings(style);
			await stopAllTeammates(
				currentCtx,
				style === "soviet" ? `The ${strings.teamNoun} is dissolved — leader moved on` : "Stopped due to session switch",
			);
		}
		stopLoops();

		currentCtx = ctx;
		currentTeamId = currentCtx.sessionManager.getSessionId();
		// Keep the task list aligned with the active session. If you want a shared namespace,
		// use `/team task use <taskListId>` after switching.
		taskListId = currentTeamId;

		await ensureTeamConfig(getTeamDir(currentTeamId), {
			teamId: currentTeamId,
			taskListId: taskListId,
			leadName: "team-lead",
			style,
		});

		await refreshTasks();
		renderWidget();

		// Restart background refresh/poll loops for the new session.
		refreshTimer = setInterval(async () => {
			if (isStopping) return;
			if (refreshInFlight) return;
			refreshInFlight = true;
			try {
				await refreshTasks();
				renderWidget();
			} finally {
				refreshInFlight = false;
			}
		}, 1000);

		inboxTimer = setInterval(async () => {
			if (isStopping) return;
			if (inboxInFlight) return;
			inboxInFlight = true;
			try {
				await pollLeaderInbox();
			} finally {
				inboxInFlight = false;
			}
		}, 700);
	});

	pi.on("session_shutdown", async () => {
		if (!currentCtx) return;
		stopLoops();
		const strings = getTeamsStrings(style);
		await stopAllTeammates(currentCtx, style === "soviet" ? `The ${strings.teamNoun} is over` : "Stopped due to leader shutdown");
	});

	registerTeamsTool({
		pi,
		teammates,
		spawnTeammate,
		getTaskListId: () => taskListId,
		taskAssignmentPayload,
		refreshTasks,
		renderWidget,
	});

	pi.registerCommand("team", {
		description: "Teams: spawn comrades + coordinate via Claude-like task list",
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
						"  /team panel",
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
					await handleTeamListCommand({
						ctx,
						teammates,
						getTeamConfig: () => teamConfig,
						refreshTasks,
						renderWidget,
					});
					return;
				}

				case "id": {
					await handleTeamIdCommand({ ctx, taskListId });
					return;
				}

				case "env": {
					await handleTeamEnvCommand({
						ctx,
						rest,
						taskListId,
						getTeamsExtensionEntryPath,
						shellQuote,
					});
					return;
				}

				case "cleanup": {
					await handleTeamCleanupCommand({
						ctx,
						rest,
						teammates,
						refreshTasks,
						getTasks: () => tasks,
						renderWidget,
						style,
					});
					return;
				}

				case "delegate": {
					await handleTeamDelegateCommand({
						ctx,
						rest,
						getDelegateMode: () => delegateMode,
						setDelegateMode: (next) => {
							delegateMode = next;
						},
						renderWidget,
					});
					return;
				}

				case "shutdown": {
					await handleTeamShutdownCommand({
						ctx,
						rest,
						teammates,
						leadName: teamConfig?.leadName ?? "team-lead",
						style,
						getCurrentCtx: () => currentCtx,
					});
					return;
				}

				case "spawn": {
					await handleTeamSpawnCommand({ ctx, rest, teammates, style, spawnTeammate });
					return;
				}

				case "style": {
					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);
					await handleTeamStyleCommand({
						ctx,
						rest,
						teamDir,
						getStyle: () => style,
						setStyle: (next) => {
							style = next;
						},
						refreshTasks,
						renderWidget,
					});
					return;
				}

				case "panel":
				case "widget": {
					const teamId = ctx.sessionManager.getSessionId();
					const teamDir = getTeamDir(teamId);
					const effectiveTlId = taskListId ?? teamId;
					const leadName = teamConfig?.leadName ?? "team-lead";
					const strings = getTeamsStrings(style);

					await openInteractiveWidget(ctx, {
						getTeammates: () => teammates,
						getTracker: () => tracker,
						getTasks: () => tasks,
						getTeamConfig: () => teamConfig,
						getStyle: () => style,
						isDelegateMode: () => delegateMode,
						async sendMessage(name: string, message: string) {
							const rpc = teammates.get(name);
							if (rpc) {
								if (rpc.status === "streaming") await rpc.followUp(message);
								else await rpc.prompt(message);
								return;
							}

							await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
								from: leadName,
								text: message,
								timestamp: new Date().toISOString(),
							});
						},
						abortComrade(name: string) {
							const rpc = teammates.get(name);
							if (rpc) void rpc.abort();
						},
						killComrade(name: string) {
							const rpc = teammates.get(name);
							if (!rpc) return;

							void rpc.stop();
							teammates.delete(name);

							const displayName = formatMemberDisplayName(style, name);
							void unassignTasksForAgent(teamDir, effectiveTlId, name, `${displayName} ${strings.killedVerb}`);
							void setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });
							void refreshTasks();
						},
						restoreWidget: renderWidget,
					});
					return;
				}

				case "send": {
					await handleTeamSendCommand({
						ctx,
						rest,
						teammates,
						style,
						renderWidget,
					});
					return;
				}

				case "steer": {
					await handleTeamSteerCommand({
						ctx,
						rest,
						teammates,
						style,
						renderWidget,
					});
					return;
				}

				case "stop": {
					await handleTeamStopCommand({
						ctx,
						rest,
						teammates,
						leadName: teamConfig?.leadName ?? "team-lead",
						style,
						refreshTasks,
						getTasks: () => tasks,
						renderWidget,
					});
					return;
				}

				case "kill": {
					await handleTeamKillCommand({
						ctx,
						rest,
						teammates,
						leadName: teamConfig?.leadName ?? "team-lead",
						style,
						taskListId,
						refreshTasks,
						renderWidget,
					});
					return;
				}

				case "dm": {
					await handleTeamDmCommand({
						ctx,
						rest,
						leadName: teamConfig?.leadName ?? "team-lead",
						style,
					});
					return;
				}

				case "broadcast": {
					await handleTeamBroadcastCommand({
						ctx,
						rest,
						teammates,
						leadName: teamConfig?.leadName ?? "team-lead",
						style,
						refreshTasks,
						getTasks: () => tasks,
						getTaskListId: () => taskListId,
					});
					return;
				}

				case "task": {
					await handleTeamTaskCommand({
						ctx,
						rest,
						getTaskListId: () => taskListId,
						setTaskListId: (id) => {
							taskListId = id;
						},
						getTasks: () => tasks,
						refreshTasks,
						renderWidget,
						parseAssigneePrefix,
						taskAssignmentPayload,
					});
					return;
				}

				case "plan": {
					await handleTeamPlanCommand({
						ctx,
						rest,
						pendingPlanApprovals,
					});
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
