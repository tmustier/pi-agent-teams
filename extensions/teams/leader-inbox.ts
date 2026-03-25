import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isPeerDmSent,
	isPlanApprovalRequest,
	isShutdownApproved,
	isShutdownRejected,
} from "./protocol.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import { getTask, isTaskBlocked, listTasks } from "./task-store.js";

import type { TeamsHookInvocation } from "./hooks.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

/** Callback to inject a message into the leader LLM conversation. */
export type SendLeaderLlmMessage = (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;

/**
 * Event-driven tracker for delegation batches.
 *
 * Tracks task IDs from delegate() calls. Tasks are only marked done
 * when an idle_notification with completedTaskId is received — NOT
 * by polling task file status. This avoids race conditions where
 * listTasks() returns stale or premature data.
 */
export class DelegationTracker {
	private batches: Array<{
		taskIds: Set<string>;
		completedIds: Set<string>;
		notified: boolean;
	}> = [];

	/** Register a new batch of delegated task IDs. */
	addBatch(taskIds: string[]): void {
		if (taskIds.length === 0) return;
		this.batches.push({
			taskIds: new Set(taskIds),
			completedIds: new Set(),
			notified: false,
		});
	}

	/**
	 * Mark a task as completed (called when idle_notification with
	 * completedTaskId is received). Returns any batches that became
	 * fully complete as a result.
	 */
	markCompleted(taskId: string): Array<{ taskIds: string[] }> {
		const newlyComplete: Array<{ taskIds: string[] }> = [];

		for (const batch of this.batches) {
			if (batch.notified) continue;
			if (!batch.taskIds.has(taskId)) continue;

			batch.completedIds.add(taskId);

			const allDone = [...batch.taskIds].every((id) => batch.completedIds.has(id));
			if (allDone) {
				batch.notified = true;
				newlyComplete.push({ taskIds: [...batch.taskIds] });
			}
		}

		// Prune notified batches
		this.batches = this.batches.filter((b) => !b.notified);
		return newlyComplete;
	}

	/** Clear all tracked batches (e.g. on session switch). */
	clear(): void {
		this.batches = [];
	}
}

/**
 * Deduplicates leader wake-up prompts when the team is stalled in the same
 * "pending tasks but nothing is in progress" state across multiple inbox polls.
 */
export class LeaderWakeTracker {
	private pendingIdleSignature: string | null = null;

	shouldNotifyPendingIdle(signature: string): boolean {
		if (this.pendingIdleSignature === signature) return false;
		this.pendingIdleSignature = signature;
		return true;
	}

	clear(): void {
		this.pendingIdleSignature = null;
	}
}

/** Truncate a result string to stay within token budget. */
function truncateResult(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "…";
}

export async function pollLeaderInbox(opts: {
	ctx: ExtensionContext;
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	enqueueHook?: (invocation: TeamsHookInvocation) => void;
	sendLeaderLlmMessage?: SendLeaderLlmMessage;
	/** Batch delegation tracker for all-tasks-complete auto-notify. */
	delegationTracker?: DelegationTracker;
	/** Deduplicates leader wake-ups for repeated "idle + pending" states. */
	wakeTracker?: LeaderWakeTracker;
}): Promise<void> {
	const { ctx, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals, enqueueHook, sendLeaderLlmMessage, delegationTracker, wakeTracker } = opts;
	const strings = getTeamsStrings(style);
	const isLeaderIdle = (): boolean => {
		const maybeCtx = ctx as ExtensionContext & { isIdle?: () => boolean };
		return typeof maybeCtx.isIdle === "function" ? maybeCtx.isIdle() : false;
	};

	let msgs: Awaited<ReturnType<typeof popUnreadMessages>>;
	try {
		msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, leadName);
	} catch (err: unknown) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
		return;
	}
	if (!msgs.length) return;

	// Collect batch completions across all messages in this poll cycle,
	// then fire notifications once at the end (avoids duplicate triggers).
	const batchCompletions: Array<{ taskIds: string[] }> = [];
	let sawPlainIdleNotification = false;

	for (const m of msgs) {
		const approved = isShutdownApproved(m.text);
		if (approved) {
			const name = sanitizeName(approved.from);
			const cfg = await ensureTeamConfig(teamDir, {
				teamId,
				taskListId,
				leadName,
				style,
			});
			if (!cfg.members.some((mm) => mm.name === name)) {
				await upsertMember(teamDir, { name, role: "worker", status: "offline" });
			}
			await setMemberStatus(teamDir, name, "offline", {
				lastSeenAt: approved.timestamp,
				meta: {
					shutdownApprovedRequestId: approved.requestId,
					shutdownApprovedAt: approved.timestamp ?? new Date().toISOString(),
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownCompletedVerb}`, "info");
			continue;
		}

		const rejected = isShutdownRejected(m.text);
		if (rejected) {
			const name = sanitizeName(rejected.from);
			await setMemberStatus(teamDir, name, "online", {
				lastSeenAt: rejected.timestamp,
				meta: {
					shutdownRejectedAt: rejected.timestamp ?? new Date().toISOString(),
					shutdownRejectedReason: rejected.reason,
				},
			});
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownRefusedVerb}: ${rejected.reason}`, "warning");
			continue;
		}

		const planReq = isPlanApprovalRequest(m.text);
		if (planReq) {
			const name = sanitizeName(planReq.from);
			const preview = planReq.plan.length > 500 ? planReq.plan.slice(0, 500) + "..." : planReq.plan;
			ctx.ui.notify(`${formatMemberDisplayName(style, name)} requests plan approval:\n${preview}`, "info");
			pendingPlanApprovals.set(name, {
				requestId: planReq.requestId,
				name,
				taskId: planReq.taskId,
			});
			continue;
		}

		const peerDm = isPeerDmSent(m.text);
		if (peerDm) {
			ctx.ui.notify(`${peerDm.from} → ${peerDm.to}: ${peerDm.summary}`, "info");
			continue;
		}

		const idle = isIdleNotification(m.text);
		if (idle) {
			if (!idle.completedTaskId && !idle.failureReason) sawPlainIdleNotification = true;
			const name = sanitizeName(idle.from);

			// Hook: always emit "idle" (best-effort, non-blocking)
			try {
				enqueueHook?.({
					event: "idle",
					teamId,
					teamDir,
					taskListId,
					style,
					memberName: name,
					timestamp: idle.timestamp,
					completedTask: null,
				});
			} catch {
				// ignore hook enqueue errors
			}

			// Hook: task completion / failure
			if (idle.completedTaskId) {
				const completedTask = await getTask(teamDir, taskListId, idle.completedTaskId);
				try {
					enqueueHook?.({
						event: idle.completedStatus === "failed" ? "task_failed" : "task_completed",
						teamId,
						teamDir,
						taskListId,
						style,
						memberName: name,
						timestamp: idle.timestamp,
						completedTask,
					});
				} catch {
					// ignore hook enqueue errors
				}

				// Event-driven batch tracking: mark this task done and
				// collect any batches that became fully complete.
				if (delegationTracker && idle.completedStatus !== "failed") {
					const completed = delegationTracker.markCompleted(idle.completedTaskId);
					batchCompletions.push(...completed);
				}
			}

			if (idle.failureReason) {
				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});
				if (!cfg.members.some((mm) => mm.name === name)) {
					await upsertMember(teamDir, { name, role: "worker", status: "offline" });
				}
				await setMemberStatus(teamDir, name, "offline", {
					lastSeenAt: idle.timestamp,
					meta: { offlineReason: idle.failureReason },
				});
				ctx.ui.notify(`${name} went offline (${idle.failureReason})`, "warning");
			} else {
				const desiredSessionName = `pi agent teams - ${strings.memberTitle.toLowerCase()} ${name}`;

				const cfg = await ensureTeamConfig(teamDir, {
					teamId,
					taskListId,
					leadName,
					style,
				});

				const member = cfg.members.find((mm) => mm.name === name);
				const existingSessionNameRaw = member?.meta?.["sessionName"];
				const existingSessionName = typeof existingSessionNameRaw === "string" ? existingSessionNameRaw : undefined;
				const shouldSendName = existingSessionName !== desiredSessionName;

				if (!member) {
					// Manual tmux worker: learn from idle notifications.
					await upsertMember(teamDir, {
						name,
						role: "worker",
						status: "online",
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				} else {
					await setMemberStatus(teamDir, name, "online", {
						lastSeenAt: idle.timestamp,
						meta: { sessionName: desiredSessionName },
					});
				}

				if (shouldSendName) {
					try {
						const ts = new Date().toISOString();
						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
							from: leadName,
							text: JSON.stringify({
								type: "set_session_name",
								name: desiredSessionName,
								from: leadName,
								timestamp: ts,
							}),
							timestamp: ts,
						});
					} catch {
						// ignore
					}
				}

				if (idle.completedTaskId && idle.completedStatus === "failed") {
					ctx.ui.notify(`${name} aborted task #${idle.completedTaskId}`, "warning");

					// Inject failure notification into leader LLM conversation
					if (sendLeaderLlmMessage) {
						const task = await getTask(teamDir, taskListId, idle.completedTaskId);
						const subject = task?.subject ? `: ${task.subject}` : "";
						// Failed tasks store abort details, not the success-only `result` field.
						const abortReasonRaw = task?.metadata?.["abortReason"];
						const partialResultRaw = task?.metadata?.["partialResult"];
						const abortReason = typeof abortReasonRaw === "string" ? truncateResult(abortReasonRaw, 300) : undefined;
						const partialResult = typeof partialResultRaw === "string" ? truncateResult(partialResultRaw, 300) : undefined;
					const lines = [
						`[Team] ${formatMemberDisplayName(style, name)} failed task #${idle.completedTaskId}${subject}`,
					];
					if (abortReason) lines.push(`Reason: ${abortReason}`);
					if (partialResult) lines.push(`Partial result: ${partialResult}`);
					const allTasks = await listTasks(teamDir, taskListId);
					const pending = allTasks.filter((t) => t.status === "pending").length;
					const inProgress = allTasks.filter((t) => t.status === "in_progress").length;
					if (pending > 0 && inProgress === 0) {
						lines.push(`State: ${pending} pending, ${inProgress} in progress.`);
						lines.push(
							"No tasks are currently in progress. Resolve blockers or reassign work and continue without waiting for the user.",
						);
					}
					sendLeaderLlmMessage(lines.join("\n"), { deliverAs: "followUp" });
				}
			} else if (idle.completedTaskId) {
					ctx.ui.notify(`${name} completed task #${idle.completedTaskId}`, "info");

					// Inject completion notification into leader LLM conversation
					if (sendLeaderLlmMessage) {
						const task = await getTask(teamDir, taskListId, idle.completedTaskId);
						const subject = task?.subject ? `: ${task.subject}` : "";
						const resultRaw = task?.metadata?.["result"];
						const result = typeof resultRaw === "string" ? truncateResult(resultRaw, 500) : undefined;
						const lines = [
							`[Team] ${formatMemberDisplayName(style, name)} completed task #${idle.completedTaskId}${subject}`,
						];
						if (result) lines.push(`Result: ${result}`);

						// Check if all tasks are now completed
						const allTasks = await listTasks(teamDir, taskListId);
						const totalTasks = allTasks.length;
						const completedTasks = allTasks.filter((t) => t.status === "completed");
						const allDone = totalTasks > 0 && completedTasks.length === totalTasks;

						if (allDone) {
							lines.push("");
							if (enqueueHook) {
								// Hooks run asynchronously and may reopen tasks or create follow-ups.
								lines.push(`All ${totalTasks} task(s) show completed — quality gates are still running and may change task states.`);
							} else {
								lines.push(`All ${totalTasks} task(s) are now completed. Review results and determine next steps.`);
							}
						} else {
							const pending = allTasks.filter((t) => t.status === "pending").length;
							const inProgress = allTasks.filter((t) => t.status === "in_progress").length;
							lines.push(`Progress: ${completedTasks.length}/${totalTasks} done (${pending} pending, ${inProgress} in progress)`);
							if (pending > 0 && inProgress === 0) {
								lines.push(
									"No tasks are currently in progress. Resolve blockers or assignments and continue without waiting for the user.",
								);
							}
						}

						sendLeaderLlmMessage(lines.join("\n"), { deliverAs: "followUp" });
					}
				} else {
					ctx.ui.notify(`${name} is idle`, "info");
				}
			}
			continue;
		}

		// Unrecognized message = teammate DM → route to leader LLM context
		if (sendLeaderLlmMessage) {
			sendLeaderLlmMessage(`[Team DM] ${m.from}: ${m.text}`, { deliverAs: "followUp" });
		} else {
			ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
		}
	}

	// Fire batch-complete notifications (deduplicated across this poll cycle).
	// Uses sendLeaderLlmMessage directly (without deliverAs) when idle so it
	// triggers a new LLM turn, waking the leader to review and continue.
	if (sendLeaderLlmMessage) {
		for (const batch of batchCompletions) {
			const taskRefs = batch.taskIds.map((id) => `#${id}`).join(", ");
			const suffix = enqueueHook
				? "Quality gates are still running and may change task states."
				: "Review the results and continue.";
			const msg = `[Team] All delegated tasks completed (${taskRefs}). ${suffix}`;
			try {
				if (isLeaderIdle()) {
					sendLeaderLlmMessage(msg);
				} else {
					sendLeaderLlmMessage(msg, { deliverAs: "followUp" });
				}
			} catch {
				ctx.ui.notify(`✅ ${msg}`, "info");
			}
		}
	}

	if (!sendLeaderLlmMessage || !sawPlainIdleNotification) return;

	const allTasks = await listTasks(teamDir, taskListId);
	const pendingTasks = allTasks.filter((t) => t.status === "pending");
	const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");

	if (pendingTasks.length === 0 || inProgressTasks.length > 0) {
		wakeTracker?.clear();
		return;
	}

	const pendingDetails = await Promise.all(
		pendingTasks.map(async (task) => ({ task, blocked: await isTaskBlocked(teamDir, taskListId, task) })),
	);
	const readyCount = pendingDetails.filter((entry) => !entry.blocked).length;
	const blockedCount = pendingDetails.length - readyCount;
	const signature = JSON.stringify(
		pendingDetails
			.slice()
			.sort((a, b) => Number(a.task.id) - Number(b.task.id))
			.map(({ task, blocked }) => ({ id: task.id, owner: task.owner ?? "", blocked })),
	);
	if (wakeTracker && !wakeTracker.shouldNotifyPendingIdle(signature)) return;

	const preview = pendingDetails
		.slice(0, 5)
		.map(({ task, blocked }) => {
			const parts = [`- #${task.id}: ${task.subject}`];
			if (task.owner) parts.push(`owner=${task.owner}`);
			parts.push(blocked ? "blocked" : "ready");
			return `${parts[0]} (${parts.slice(1).join(", ")})`;
		})
		.join("\n");

	const lines = [
		`[Team] No tasks are currently in progress, but ${pendingTasks.length} pending task(s) remain and teammates are idle.`,
		`State: ${pendingTasks.length} pending (${readyCount} ready, ${blockedCount} blocked), ${inProgressTasks.length} in progress.`,
		readyCount > 0
			? "There is ready work that was not picked up automatically. Reassign it or investigate why it was not claimed."
			: "The remaining tasks appear blocked or otherwise need leader intervention before workers can continue.",
		preview ? `Pending tasks:\n${preview}` : undefined,
		pendingTasks.length > 5 ? `... ${pendingTasks.length - 5} more pending task(s)` : undefined,
		"Review the task graph, resolve blockers or assignments, and continue without waiting for the user.",
	].filter((line): line is string => Boolean(line));

	if (isLeaderIdle()) sendLeaderLlmMessage(lines.join("\n"));
	else sendLeaderLlmMessage(lines.join("\n"), { deliverAs: "followUp" });
}
