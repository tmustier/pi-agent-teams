import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { getTeamDir } from "./paths.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import {
	claimNextAvailableTask,
	completeTask,
	getTask,
	isTaskBlocked,
	startAssignedTask,
	unassignTasksForAgent,
	updateTask,
	type TeamTask,
} from "./task-store.js";

const TEAM_MAILBOX_NS = "team";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function teamDirFromEnv(): {
	teamId: string;
	teamDir: string;
	taskListId: string;
	agentName: string;
	leadName: string;
	autoClaim: boolean;
} | null {
	const teamId = process.env.PI_TEAMS_TEAM_ID;
	const agentNameRaw = process.env.PI_TEAMS_AGENT_NAME;
	if (!teamId || !agentNameRaw) return null;

	const agentName = sanitize(agentNameRaw);
	const taskListId = process.env.PI_TEAMS_TASK_LIST_ID ?? teamId;
	const leadName = sanitize(process.env.PI_TEAMS_LEAD_NAME ?? "team-lead");
	const autoClaim = (process.env.PI_TEAMS_AUTO_CLAIM ?? "1") === "1";

	return {
		teamId,
		teamDir: getTeamDir(teamId),
		taskListId,
		agentName,
		leadName,
		autoClaim,
	};
}

function extractLastAssistantText(messages: AgentMessage[]): string {
	const assistant = messages.filter((m: any) => m && typeof m === "object" && m.role === "assistant");
	const last: any = assistant[assistant.length - 1];
	if (!last) return "";

	const content = last.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === "object" && c.type === "text" && typeof (c as any).text === "string")
			.map((c: any) => c.text)
			.join("");
	}
	return "";
}

function buildTaskPrompt(agentName: string, task: TeamTask): string {
	return [
		`You are teammate '${agentName}'.`,
		`You have been assigned task #${task.id}.`,
		`Subject: ${task.subject}`,
		"",
		`Description:\n${task.description}`,
		"",
		"Do the work now. When finished, reply with a concise summary and any key outputs.",
	].join("\n");
}

function isTaskAssignmentMessage(text: string): { taskId: string; subject?: string; description?: string; assignedBy?: string } | null {
	try {
		const obj = JSON.parse(text);
		if (!obj || typeof obj !== "object") return null;
		if (obj.type !== "task_assignment") return null;
		if (typeof obj.taskId !== "string") return null;
		return {
			taskId: obj.taskId,
			subject: typeof obj.subject === "string" ? obj.subject : undefined,
			description: typeof obj.description === "string" ? obj.description : undefined,
			assignedBy: typeof obj.assignedBy === "string" ? obj.assignedBy : undefined,
		};
	} catch {
		return null;
	}
}

function isShutdownRequestMessage(text: string): { requestId: string; from?: string; reason?: string; timestamp?: string } | null {
	try {
		const obj = JSON.parse(text);
		if (!obj || typeof obj !== "object") return null;
		if (obj.type !== "shutdown_request") return null;
		if (typeof obj.requestId !== "string") return null;
		return {
			requestId: obj.requestId,
			from: typeof obj.from === "string" ? obj.from : undefined,
			reason: typeof obj.reason === "string" ? obj.reason : undefined,
			timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
		};
	} catch {
		return null;
	}
}

function isSetSessionNameMessage(text: string): { name: string } | null {
	try {
		const obj = JSON.parse(text);
		if (!obj || typeof obj !== "object") return null;
		if (obj.type !== "set_session_name") return null;
		if (typeof obj.name !== "string") return null;
		return { name: obj.name };
	} catch {
		return null;
	}
}

function isAbortRequestMessage(
	text: string,
): { requestId: string; from?: string; taskId?: string; reason?: string; timestamp?: string } | null {
	try {
		const obj = JSON.parse(text);
		if (!obj || typeof obj !== "object") return null;
		if (obj.type !== "abort_request") return null;
		if (typeof obj.requestId !== "string") return null;
		return {
			requestId: obj.requestId,
			from: typeof obj.from === "string" ? obj.from : undefined,
			taskId: typeof obj.taskId === "string" ? obj.taskId : undefined,
			reason: typeof obj.reason === "string" ? obj.reason : undefined,
			timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
		};
	} catch {
		return null;
	}
}

export function runWorker(pi: ExtensionAPI): void {
	const env = teamDirFromEnv();
	if (!env) return;

	let ctxRef: ExtensionContext | null = null;
	let isStreaming = false;
	let isDeciding = false;
	let currentTaskId: string | null = null;
	let pendingTaskAssignments: string[] = [];
	let pendingDmTexts: string[] = [];
	let pollAbort = false;
	let shutdownInProgress = false;
	const seenShutdownRequestIds = new Set<string>();

	let abortTaskId: string | null = null;
	let abortReason: string | undefined;
	let abortRequestId: string | null = null;
	const seenAbortRequestIds = new Set<string>();

	const { teamId, teamDir, taskListId, agentName, leadName, autoClaim } = env;

	const poll = async () => {
		while (!pollAbort) {
			try {
				// Two namespaces (Claude-style):
				// - team namespace for DM/idle notifications
				// - taskListId namespace for task_assignment pings
				const [teamMsgs, taskMsgs] = await Promise.all([
					popUnreadMessages(teamDir, TEAM_MAILBOX_NS, agentName),
					popUnreadMessages(teamDir, taskListId, agentName),
				]);

				for (const m of [...taskMsgs, ...teamMsgs]) {
					const shutdown = isShutdownRequestMessage(m.text);
					if (shutdown && !seenShutdownRequestIds.has(shutdown.requestId)) {
						seenShutdownRequestIds.add(shutdown.requestId);
						shutdownInProgress = true;
						pollAbort = true;

						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
							from: agentName,
							text: JSON.stringify({
								type: "shutdown_approved",
								requestId: shutdown.requestId,
								from: agentName,
								timestamp: ts,
							}),
							timestamp: ts,
						});

						try {
							await cleanup("shutdown requested");
						} catch {
							// ignore
						}

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						try {
							ctxRef?.shutdown();
						} catch {
							// ignore
						}
						return;
					}

					const setName = isSetSessionNameMessage(m.text);
					if (setName) {
						const desired = setName.name.trim();
						if (desired) {
							try {
								const existing = pi.getSessionName?.();
								// Only overwrite sessions that are unnamed or already managed by us.
								if (!existing || existing.startsWith("pi agent teams -")) {
									if (existing !== desired) pi.setSessionName(desired);
								}
							} catch {
								// ignore
							}
						}
						continue;
					}

					const abortReq = isAbortRequestMessage(m.text);
					if (abortReq && !seenAbortRequestIds.has(abortReq.requestId)) {
						seenAbortRequestIds.add(abortReq.requestId);

						// If the request targets a specific task and we're busy on a different one, ignore.
						if (abortReq.taskId && currentTaskId && abortReq.taskId !== currentTaskId) continue;

						if (currentTaskId) {
							abortTaskId = currentTaskId;
							abortReason = abortReq.reason;
							abortRequestId = abortReq.requestId;
						}

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						continue;
					}

					const assign = isTaskAssignmentMessage(m.text);
					if (assign) {
						pendingTaskAssignments.push(assign.taskId);
						continue;
					}
					// Plain DM (or unknown structured message)
					pendingDmTexts.push(m.text);
				}

				if (!shutdownInProgress) await maybeStartNextWork();
			} catch {
				// ignore polling errors
			}

			await sleep(350);
		}
	};

	const maybeStartNextWork = async () => {
		if (!ctxRef) return;
		if (shutdownInProgress) return;
		if (isStreaming) return;
		if (currentTaskId) return;
		if (isDeciding) return;

		isDeciding = true;
		try {
			// 1) Assigned tasks
			const requeue: string[] = [];
			while (pendingTaskAssignments.length) {
				const taskId = pendingTaskAssignments.shift()!;
				const task = await getTask(teamDir, taskListId, taskId);
				if (!task) continue;
				if (task.owner !== agentName) continue;
				if (task.status === "completed") continue;

				// Respect deps: don't start assigned tasks until unblocked.
				if (await isTaskBlocked(teamDir, taskListId, task)) {
					requeue.push(taskId);
					continue;
				}

				// Mark in_progress if needed
				if (task.status === "pending") await startAssignedTask(teamDir, taskListId, taskId, agentName);

				currentTaskId = taskId;
				isStreaming = true; // optimistic; agent_start will follow
				pi.sendUserMessage(buildTaskPrompt(agentName, task));
				pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];
				return;
			}
			pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];

			// 2) DMs
			if (pendingDmTexts.length) {
				const text = pendingDmTexts.join("\n\n---\n\n");
				pendingDmTexts = [];
				isStreaming = true;
				pi.sendUserMessage([
					{ type: "text", text: "You have received teammate message(s):" },
					{ type: "text", text },
				]);
				return;
			}

			// 3) Auto-claim
			if (autoClaim) {
				const claimed = await claimNextAvailableTask(teamDir, taskListId, agentName, { checkAgentBusy: true });
				if (claimed) {
					currentTaskId = claimed.id;
					isStreaming = true;
					pi.sendUserMessage(buildTaskPrompt(agentName, claimed));
					return;
				}
			}
		} finally {
			isDeciding = false;
		}
	};

	const sendIdleNotification = async (
		completedTaskId?: string,
		completedStatus?: "completed" | "failed",
		failureReason?: string,
	) => {
		const payload: any = {
			type: "idle_notification",
			from: agentName,
			timestamp: new Date().toISOString(),
		};
		if (completedTaskId) payload.completedTaskId = completedTaskId;
		if (completedStatus) payload.completedStatus = completedStatus;
		if (failureReason) payload.failureReason = failureReason;

		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
			from: agentName,
			text: JSON.stringify(payload),
			timestamp: new Date().toISOString(),
		});
	};

	const cleanup = async (reason: string) => {
		try {
			await unassignTasksForAgent(teamDir, taskListId, agentName, reason);
		} catch {
			// ignore
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;


		// Register ourselves in the shared team config so manual tmux workers are discoverable.
		try {
			const cfg = await ensureTeamConfig(teamDir, { teamId, taskListId, leadName });
			const now = new Date().toISOString();
			if (!cfg.members.some((m) => m.name === agentName)) {
				await upsertMember(teamDir, {
					name: agentName,
					role: "worker",
					status: "online",
					lastSeenAt: now,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
				});
			} else {
				await setMemberStatus(teamDir, agentName, "online", { lastSeenAt: now });
			}
		} catch {
			// ignore config errors
		}

		void poll();
		await maybeStartNextWork();
		// Claude-style: let the leader know we're idle even if no task was completed yet.
		if (!isStreaming && !currentTaskId) {
			await sendIdleNotification();
		}
	});

	pi.on("session_shutdown", async () => {
		pollAbort = true;
		await cleanup("worker shutdown");
		try {
			await setMemberStatus(teamDir, agentName, "offline", { meta: { offlineReason: "worker shutdown" } });
		} catch {
			// ignore
		}
		await sendIdleNotification(undefined, undefined, "worker shutdown");
	});

	pi.on("agent_start", async () => {
		isStreaming = true;
	});

	pi.on("agent_end", async (event) => {
		isStreaming = false;
		const taskId = currentTaskId;
		currentTaskId = null;

		let completedTaskId: string | undefined;
		let completedStatus: "completed" | "failed" | undefined;
		let failureReason: string | undefined;

		try {
			if (taskId) {
				const rawResult = extractLastAssistantText(event.messages as AgentMessage[]);
				const trimmed = rawResult.trim();
				const abortedByRequest = abortTaskId === taskId;
				const aborted = abortedByRequest || trimmed.length === 0;

				if (aborted) {
					const ts = new Date().toISOString();
					const extra: Record<string, unknown> = {
						abortedAt: ts,
						abortedBy: agentName,
					};

					if (abortedByRequest) {
						if (abortRequestId) extra.abortRequestId = abortRequestId;
						extra.abortReason = abortReason ?? "abort requested";
						if (trimmed.length > 0) extra.partialResult = rawResult;
					} else {
						extra.abortReason = "no assistant result";
					}

					await updateTask(teamDir, taskListId, taskId, (cur) => {
						if (cur.owner !== agentName) return cur;
						if (cur.status === "completed") return cur;

						const metadata = { ...(cur.metadata ?? {}) };
						Object.assign(metadata, extra);

						// Reset to pending, but keep owner. This avoids immediate re-claim loops after an abort.
						return { ...cur, status: "pending", metadata };
					});
					completedTaskId = taskId;
					completedStatus = "failed";
				} else {
					await completeTask(teamDir, taskListId, taskId, agentName, rawResult);
					completedTaskId = taskId;
					completedStatus = "completed";
				}
			}
		} finally {
			abortTaskId = null;
			abortReason = undefined;
			abortRequestId = null;
		}

		await maybeStartNextWork();

		// Only tell the leader we're idle if we truly didn't start more work.
		if (!isStreaming && !currentTaskId) {
			await sendIdleNotification(completedTaskId, completedStatus, failureReason);
		}
	});

	// Best-effort cleanup on SIGTERM (leader kill).
	process.on("SIGTERM", () => {
		pollAbort = true;
		void (async () => {
			await cleanup("SIGTERM");
			try {
				await setMemberStatus(teamDir, agentName, "offline", { meta: { offlineReason: "SIGTERM" } });
			} catch {
				// ignore
			}
			await sendIdleNotification(undefined, undefined, "SIGTERM");
		})().finally(() => process.exit(0));
	});
}
