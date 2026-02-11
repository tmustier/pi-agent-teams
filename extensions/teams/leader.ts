import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { TEAM_MAILBOX_NS, taskAssignmentPayload } from "./protocol.js";
import { createTask, listTasks, unassignTasksForAgent, updateTask, type TeamTask } from "./task-store.js";
import { TeammateRpc } from "./teammate-rpc.js";
import { ensureTeamConfig, loadTeamConfig, setMemberStatus, upsertMember, type TeamConfig } from "./team-config.js";
import { getTeamDir } from "./paths.js";
import { heartbeatTeamAttachClaim, releaseTeamAttachClaim } from "./team-attach-claim.js";
import { ensureWorktreeCwd } from "./worktree.js";
import { ActivityTracker, TranscriptTracker } from "./activity-tracker.js";
import { openInteractiveWidget } from "./teams-panel.js";
import { createTeamsWidget } from "./teams-widget.js";
import { getTeamsStyleFromEnv, type TeamsStyle, formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import { pollLeaderInbox as pollLeaderInboxImpl } from "./leader-inbox.js";
import {
	getHookBaseName,
	getTeamsHookFailureAction,
	runTeamsHook,
	shouldCreateHookFollowupTask,
	shouldReopenTaskOnHookFailure,
	type TeamsHookInvocation,
} from "./hooks.js";
import { handleTeamCommand } from "./leader-team-command.js";
import { registerTeamsTool } from "./leader-teams-tool.js";
import type { ContextMode, SpawnTeammateFn, SpawnTeammateResult, WorkspaceMode } from "./spawn-types.js";

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

// Message parsers are shared with the worker implementation.
export function runLeader(pi: ExtensionAPI): void {
	const teammates = new Map<string, TeammateRpc>();
	const tracker = new ActivityTracker();
	const transcriptTracker = new TranscriptTracker();
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
	let lastAttachClaimHeartbeatMs = 0;

	const stopLoops = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (inboxTimer) clearInterval(inboxTimer);
		refreshTimer = null;
		inboxTimer = null;
	};

	const releaseActiveAttachClaim = async (ctx: ExtensionContext): Promise<void> => {
		if (!currentTeamId) return;
		const sessionTeamId = ctx.sessionManager.getSessionId();
		if (currentTeamId === sessionTeamId) return;
		await releaseTeamAttachClaim(getTeamDir(currentTeamId), sessionTeamId);
	};

	const heartbeatActiveAttachClaim = async (ctx: ExtensionContext): Promise<void> => {
		if (!currentTeamId) return;
		const sessionTeamId = ctx.sessionManager.getSessionId();
		if (currentTeamId === sessionTeamId) return;
		const nowMs = Date.now();
		if (nowMs - lastAttachClaimHeartbeatMs < 5_000) return;
		lastAttachClaimHeartbeatMs = nowMs;
		const result = await heartbeatTeamAttachClaim(getTeamDir(currentTeamId), sessionTeamId);
		if (result === "updated") return;

		ctx.ui.notify(
			`Attach claim for team ${currentTeamId} is no longer owned by this session; detaching to session team.`,
			"warning",
		);
		currentTeamId = sessionTeamId;
		taskListId = sessionTeamId;
		await refreshTasks();
		renderWidget();
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
				transcriptTracker.reset(name);

				await t.stop();
				// Claude-style: unassign non-completed tasks on exit.
				const teamId = currentTeamId ?? ctx.sessionManager.getSessionId();
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

	// Hooks / quality gates (serialized execution so multiple idle events don't overlap).
	let hookChain: Promise<void> = Promise.resolve();
	const seenHookEvents = new Set<string>();

	const enqueueHook = (invocation: TeamsHookInvocation) => {
		const taskId = invocation.completedTask?.id ?? "";
		const ts = invocation.timestamp ?? "";
		const key = `${invocation.teamId}:${invocation.event}:${taskId}:${ts}:${invocation.memberName ?? ""}`;
		if (seenHookEvents.has(key)) return;
		seenHookEvents.add(key);

		hookChain = hookChain
			.then(async () => {
				// Only run hooks for the currently active team session.
				if (!currentCtx) return;
				if (!currentTeamId || currentTeamId !== invocation.teamId) return;

				const res = await runTeamsHook({ invocation, cwd: currentCtx.cwd });
				if (!res.ran) return;

				// Persist a log for debugging.
				try {
					const logsDir = path.join(invocation.teamDir, "hook-logs");
					await fs.promises.mkdir(logsDir, { recursive: true });
					const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${invocation.event}.json`;
					await fs.promises.writeFile(
						path.join(logsDir, name),
						JSON.stringify(
							{
								invocation,
								result: res,
							},
							null,
							2,
						) + "\n",
						"utf8",
					);
				} catch {
					// ignore logging errors
				}

				const ok = res.exitCode === 0 && !res.timedOut && !res.error;
				const hookName = getHookBaseName(invocation.event);
				const failureAction = getTeamsHookFailureAction(process.env);
				const shouldFollowup = shouldCreateHookFollowupTask(failureAction);
				const shouldReopen = shouldReopenTaskOnHookFailure(failureAction);
				const task = invocation.completedTask;

				const stderrFirstLine = res.stderr
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find((line) => line.length > 0);
				const failureParts: string[] = [];
				if (res.error) failureParts.push(res.error);
				if (res.timedOut) failureParts.push(`timeout after ${res.durationMs}ms`);
				if (!res.timedOut && res.exitCode !== null && res.exitCode !== 0) failureParts.push(`exit code ${res.exitCode}`);
				if (stderrFirstLine) failureParts.push(stderrFirstLine.length > 180 ? `${stderrFirstLine.slice(0, 179)}…` : stderrFirstLine);
				const failureSummary = failureParts.join(" • ") || "hook failed";

				// Idle hooks are intentionally quiet unless they fail.
				if (invocation.event === "idle") {
					if (!ok) {
						currentCtx.ui.notify(`Hook ${hookName} failed: ${failureSummary}`, "warning");
					}
					return;
				}

				let taskReopened = false;
				if (task?.id) {
					const nowIso = new Date().toISOString();
					await updateTask(invocation.teamDir, invocation.taskListId, task.id, (cur) => {
						const metadata = { ...(cur.metadata ?? {}) };
						const prevFailureCountRaw = metadata["qualityGateFailureCount"];
						const prevFailureCount =
							typeof prevFailureCountRaw === "number" && Number.isFinite(prevFailureCountRaw) ? prevFailureCountRaw : 0;

						metadata["qualityGateHook"] = hookName;
						metadata["qualityGateAt"] = nowIso;

						if (ok) {
							metadata["qualityGateStatus"] = "passed";
							metadata["qualityGateSummary"] = `passed in ${res.durationMs}ms`;
							metadata["qualityGateLastSuccessAt"] = nowIso;
							return { ...cur, metadata };
						}

						metadata["qualityGateStatus"] = "failed";
						metadata["qualityGateSummary"] = failureSummary;
						metadata["qualityGateFailureCount"] = prevFailureCount + 1;
						metadata["qualityGateLastFailureAt"] = nowIso;

						if (shouldReopen && cur.status === "completed") {
							taskReopened = true;
							metadata["reopenedByQualityGateAt"] = nowIso;
							metadata["reopenedByQualityGateHook"] = hookName;
							return { ...cur, status: "pending", metadata };
						}
						return { ...cur, metadata };
					});

					await refreshTasks();
					renderWidget();
				}

				if (ok) {
					const taskRef = task?.id ? ` for task #${task.id}` : "";
					currentCtx.ui.notify(`Hook ${hookName} passed${taskRef} (${res.durationMs}ms)`, "info");
					return;
				}

				const failedTaskRef = task?.id ? ` for task #${task.id}` : "";
				currentCtx.ui.notify(`Hook ${hookName} failed${failedTaskRef}: ${failureSummary}`, "warning");
				if (taskReopened && task?.id) {
					currentCtx.ui.notify(`Reopened task #${task.id} due to quality-gate failure`, "warning");
				}

				if (shouldFollowup && task?.id) {
					const subject = `Quality gate failed: ${hookName} (task #${task.id})`;
					const descParts: string[] = [];
					descParts.push(`Hook: ${hookName}`);
					descParts.push(`Policy: ${failureAction}`);
					descParts.push(`Failure: ${failureSummary}`);
					if (res.command?.length) descParts.push(`Command: ${res.command.join(" ")}`);
					descParts.push("");
					if (task.subject) descParts.push(`Original task subject: ${task.subject}`);
					descParts.push("");
					if (res.stdout.trim()) {
						descParts.push("STDOUT:");
						descParts.push(res.stdout.trim());
						descParts.push("");
					}
					if (res.stderr.trim()) {
						descParts.push("STDERR:");
						descParts.push(res.stderr.trim());
						descParts.push("");
					}

					await createTask(invocation.teamDir, invocation.taskListId, {
						subject,
						description: descParts.join("\n"),
					});
					await refreshTasks();
					renderWidget();
				}
			})
			.catch((err: unknown) => {
				if (!currentCtx) return;
				currentCtx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
			});
	};

	const widgetFactory = createTeamsWidget({
		getTeammates: () => teammates,
		getTracker: () => tracker,
		getTasks: () => tasks,
		getTeamConfig: () => teamConfig,
		getStyle: () => style,
		isDelegateMode: () => delegateMode,
		getActiveTeamId: () => currentTeamId,
		getSessionTeamId: () => currentCtx?.sessionManager.getSessionId() ?? null,
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

	let widgetSuppressed = false;

	const renderWidget = () => {
		if (!currentCtx || widgetSuppressed) return;
		// Component widget (more informative + styled). Re-setting it is also our "refresh" trigger.
		currentCtx.ui.setWidget("pi-teams", widgetFactory);
	};

	const spawnTeammate: SpawnTeammateFn = async (ctx, opts): Promise<SpawnTeammateResult> => {
		const warnings: string[] = [];
		const mode: ContextMode = opts.mode ?? "fresh";
		let workspaceMode: WorkspaceMode = opts.workspaceMode ?? "shared";

		const name = sanitizeName(opts.name);
		if (!name) return { ok: false, error: "Missing comrade name" };
		if (teammates.has(name)) {
			const strings = getTeamsStrings(style);
			return { ok: false, error: `${formatMemberDisplayName(style, name)} already exists (${strings.teamNoun})` };
		}

		// Spawn-time model / thinking overrides (optional).
		const thinkingLevel = opts.thinking ?? pi.getThinkingLevel();
		let childProvider: string | undefined;
		let childModelId: string | undefined;

		const modelOverrideRaw = opts.model?.trim();
		if (modelOverrideRaw) {
			const slashIdx = modelOverrideRaw.indexOf("/");
			if (slashIdx >= 0) {
				const provider = modelOverrideRaw.slice(0, slashIdx).trim();
				const id = modelOverrideRaw.slice(slashIdx + 1).trim();
				if (!provider || !id) {
					return {
						ok: false,
						error: `Invalid model override '${modelOverrideRaw}'. Expected <provider>/<modelId>.`,
					};
				}
				childProvider = provider;
				childModelId = id;
			} else {
				childModelId = modelOverrideRaw;
				childProvider = ctx.model?.provider;
				if (!childProvider) {
					warnings.push(
						`Model override '${modelOverrideRaw}' provided without a provider. ` +
							`Teammate will use its default provider; use <provider>/<modelId> to force one.`,
					);
				}
			}
		} else if (ctx.model) {
			childProvider = ctx.model.provider;
			childModelId = ctx.model.id;
		}

		const teamId = currentTeamId ?? ctx.sessionManager.getSessionId();
		const teamDir = getTeamDir(teamId);
		const teamSessionsDir = getTeamSessionsDir(teamDir);
		const session = await createSessionForTeammate(ctx, mode, teamSessionsDir);
		const { sessionFile, note } = session;
		warnings.push(...session.warnings);

		const t = new TeammateRpc(name, sessionFile);
		teammates.set(name, t);
		// Track teammate activity for the widget/panel.
		const unsub = t.onEvent((ev) => {
			tracker.handleEvent(name, ev);
			transcriptTracker.handleEvent(name, ev);
		});
		teammateEventUnsubs.set(name, unsub);
		renderWidget();

		// On crash/close, unassign tasks like Claude.
		const leaderTeamId = teamId;
		t.onClose((code) => {
			try {
				teammateEventUnsubs.get(name)?.();
			} catch {
				// ignore
			}
			teammateEventUnsubs.delete(name);
			tracker.reset(name);
			transcriptTracker.reset(name);

			if (currentTeamId !== leaderTeamId) return;
			const effectiveTlId = taskListId ?? leaderTeamId;
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

		// Model + thinking for the child process.
		if (childModelId) {
			if (childProvider) argsForChild.push("--provider", childProvider);
			argsForChild.push("--model", childModelId);
		}
		argsForChild.push("--thinking", thinkingLevel);

		const teamsEntry = getTeamsExtensionEntryPath();
		if (teamsEntry) {
			argsForChild.push("--no-extensions", "-e", teamsEntry);
		}

		const strings = getTeamsStrings(style);
		const systemAppend = `You are ${strings.memberTitle.toLowerCase()} '${name}'. You collaborate with the ${strings.leaderTitle.toLowerCase()}. Prefer working from the shared task list.\n`;
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
			meta: {
				workspaceMode,
				sessionName,
				thinkingLevel,
				...(childModelId ? { model: childProvider ? `${childProvider}/${childModelId}` : childModelId } : {}),
			},
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
			enqueueHook,
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
		lastAttachClaimHeartbeatMs = 0;

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
				await heartbeatActiveAttachClaim(ctx);
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
			await releaseActiveAttachClaim(currentCtx);
			const strings = getTeamsStrings(style);
			await stopAllTeammates(currentCtx, `The ${strings.teamNoun} is dissolved — leader moved on`);
		}
		stopLoops();

		currentCtx = ctx;
		currentTeamId = currentCtx.sessionManager.getSessionId();
		// Keep the task list aligned with the active session. If you want a shared namespace,
		// use `/team task use <taskListId>` after switching.
		taskListId = currentTeamId;
		lastAttachClaimHeartbeatMs = 0;

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
				await heartbeatActiveAttachClaim(ctx);
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
		await releaseActiveAttachClaim(currentCtx);
		stopLoops();
		const strings = getTeamsStrings(style);
		await stopAllTeammates(currentCtx, `The ${strings.teamNoun} is over`);
	});

	registerTeamsTool({
		pi,
		teammates,
		spawnTeammate,
		getTeamId: (ctx) => currentTeamId ?? ctx.sessionManager.getSessionId(),
		getTaskListId: () => taskListId,
		refreshTasks,
		renderWidget,
		pendingPlanApprovals,
	});

	const openWidget = async (ctx: ExtensionCommandContext) => {
		const teamId = currentTeamId ?? ctx.sessionManager.getSessionId();
		const teamDir = getTeamDir(teamId);
		const effectiveTlId = taskListId ?? teamId;
		const leadName = teamConfig?.leadName ?? "team-lead";
		const strings = getTeamsStrings(style);

		await openInteractiveWidget(ctx, {
			getTeammates: () => teammates,
			getTracker: () => tracker,
			getTranscript: (n: string) => transcriptTracker.get(n),
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
			abortMember(name: string) {
				const rpc = teammates.get(name);
				if (rpc) void rpc.abort();
			},
			killMember(name: string) {
				const rpc = teammates.get(name);
				if (!rpc) return;

				void rpc.stop();
				teammates.delete(name);

				const displayName = formatMemberDisplayName(style, name);
				void unassignTasksForAgent(teamDir, effectiveTlId, name, `${displayName} ${strings.killedVerb}`);
				void setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });
				void refreshTasks();
			},
			async setTaskStatus(taskId: string, status: TeamTask["status"]) {
				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					if (cur.status === status) return cur;
					const metadata = { ...(cur.metadata ?? {}) };
					if (status === "completed") metadata.completedAt = new Date().toISOString();
					if (status !== "completed" && cur.status === "completed") metadata.reopenedAt = new Date().toISOString();
					return { ...cur, status, metadata };
				});
				if (!updated) return false;
				await refreshTasks();
				renderWidget();
				return true;
			},
			async unassignTask(taskId: string) {
				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					if (!cur.owner) return cur;
					if (cur.status === "completed") return { ...cur, owner: undefined };
					const metadata = { ...(cur.metadata ?? {}) };
					metadata.unassignedAt = new Date().toISOString();
					metadata.unassignedReason = "leader-panel";
					return { ...cur, owner: undefined, status: "pending", metadata };
				});
				if (!updated) return false;
				await refreshTasks();
				renderWidget();
				return true;
			},
			async assignTask(taskId: string, ownerName: string) {
				const owner = sanitizeName(ownerName);
				if (!owner) return false;
				const updated = await updateTask(teamDir, effectiveTlId, taskId, (cur) => {
					const metadata = { ...(cur.metadata ?? {}) };
					metadata.reassignedAt = new Date().toISOString();
					metadata.reassignedBy = leadName;
					metadata.reassignedTo = owner;
					if (cur.status === "completed") return { ...cur, owner, metadata };
					return { ...cur, owner, status: "pending", metadata };
				});
				if (!updated) return false;

				await writeToMailbox(teamDir, effectiveTlId, owner, {
					from: leadName,
					text: JSON.stringify(taskAssignmentPayload(updated, leadName)),
					timestamp: new Date().toISOString(),
				});

				await refreshTasks();
				renderWidget();
				return true;
			},
			getActiveTeamId() {
				return currentTeamId;
			},
			getSessionTeamId() {
				return ctx.sessionManager.getSessionId();
			},
			suppressWidget() {
				widgetSuppressed = true;
				ctx.ui.setWidget("pi-teams", undefined);
			},
			restoreWidget() {
				widgetSuppressed = false;
				renderWidget();
			},
		});
	};

	pi.registerCommand("tw", {
		description: "Teams: open interactive widget panel",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();
			await openWidget(ctx);
		},
	});

	pi.registerCommand("team-widget", {
		description: "Teams: open interactive widget panel (alias for /team widget)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();
			await openWidget(ctx);
		},
	});

	pi.registerCommand("swarm", {
		description: "Start a team of agents to work on a task",
		handler: async (args, _ctx) => {
			const task = args.trim();
			if (!task) {
				pi.sendUserMessage("Use your /team commands to spawn a team of agents and coordinate them to complete my next request. Ask me what I'd like done.");
				return;
			}
			pi.sendUserMessage(`Use your /team commands to spawn a team of agents and coordinate them to complete this task:\n\n${task}`);
		},
	});

	pi.registerCommand("team", {
		description: "Teams: spawn comrades + coordinate via Claude-like task list",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			if (!currentTeamId) currentTeamId = ctx.sessionManager.getSessionId();

			await handleTeamCommand({
				args,
				ctx,
				teammates,
				getTeamConfig: () => teamConfig,
				getTasks: () => tasks,
				refreshTasks,
				renderWidget,
				getTaskListId: () => taskListId,
				setTaskListId: (id) => {
					taskListId = id;
				},
				getActiveTeamId: () => currentTeamId ?? ctx.sessionManager.getSessionId(),
				setActiveTeamId: (teamId) => {
					currentTeamId = teamId;
				},
				pendingPlanApprovals,
				getDelegateMode: () => delegateMode,
				setDelegateMode: (next) => {
					delegateMode = next;
				},
				getStyle: () => style,
				setStyle: (next) => {
					style = next;
				},
				spawnTeammate,
				openWidget,
				getTeamsExtensionEntryPath,
				shellQuote,
				getCurrentCtx: () => currentCtx,
				stopAllTeammates,
			});
		},
	});
}
