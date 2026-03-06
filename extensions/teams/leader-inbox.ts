import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
import { getTask, listTasks } from "./task-store.js";

import type { TeamsHookInvocation } from "./hooks.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

/**
 * Tracks task IDs from delegate calls so the leader can auto-notify
 * when all delegated tasks in a batch complete.
 *
 * Each delegation batch is a Set of task IDs. When all IDs in a batch
 * reach "completed", the auto-notify fires. Per-task notifications
 * are handled separately (see `onTaskCompleted` callback).
 */
export class DelegationTracker {
	private batches: Array<{ taskIds: Set<string>; notified: boolean }> = [];

	/** Register a new batch of delegated task IDs. */
	addBatch(taskIds: string[]): void {
		if (taskIds.length === 0) return;
		this.batches.push({ taskIds: new Set(taskIds), notified: false });
	}

	/** Check all batches against current task statuses and return newly completed batches. */
	async checkCompleted(teamDir: string, taskListId: string): Promise<Array<{ taskIds: string[] }>> {
		if (this.batches.length === 0) return [];

		const allTasks = await listTasks(teamDir, taskListId);
		const statusById = new Map<string, string>();
		for (const t of allTasks) statusById.set(t.id, t.status);

		const completed: Array<{ taskIds: string[] }> = [];
		for (const batch of this.batches) {
			if (batch.notified) continue;
			const allDone = [...batch.taskIds].every((id) => {
				const status = statusById.get(id);
				return status === "completed";
			});
			if (allDone) {
				batch.notified = true;
				completed.push({ taskIds: [...batch.taskIds] });
			}
		}

		// Prune notified batches to avoid unbounded growth
		this.batches = this.batches.filter((b) => !b.notified);
		return completed;
	}

	/** Clear all tracked batches (e.g. on session switch). */
	clear(): void {
		this.batches = [];
	}
}

export async function pollLeaderInbox(opts: {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	enqueueHook?: (invocation: TeamsHookInvocation) => void;
	/** PR #6 compat: callback for teammate DMs routed to leader LLM context. */
	onDm?: (from: string, text: string) => void;
	/** Callback for per-task completion notifications routed to leader LLM context. */
	onTaskCompleted?: (memberName: string, taskId: string, taskSubject: string) => void;
	/** Batch delegation tracker for all-tasks-complete auto-notify. */
	delegationTracker?: DelegationTracker;
}): Promise<void> {
	const { ctx, pi, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals, enqueueHook, onDm, onTaskCompleted, delegationTracker } = opts;
	const strings = getTeamsStrings(style);

	let msgs: Awaited<ReturnType<typeof popUnreadMessages>>;
	try {
		msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, leadName);
	} catch (err: unknown) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
		return;
	}
	if (!msgs.length) return;

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

				// Per-task completion notification → inject into leader LLM context
				if (idle.completedStatus !== "failed" && onTaskCompleted && completedTask) {
					try {
						onTaskCompleted(name, idle.completedTaskId, completedTask.subject ?? `task #${idle.completedTaskId}`);
					} catch {
						// ignore notification errors
					}
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
				} else if (idle.completedTaskId) {
					ctx.ui.notify(`${name} is idle task #${idle.completedTaskId}`, "info");
				} else {
					ctx.ui.notify(`${name} is idle`, "info");
				}
			}
			continue;
		}

		// Unrecognized message = teammate DM to leader
		if (onDm) {
			onDm(m.from, m.text);
		} else {
			ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
		}
	}

	// Auto-notify leader when all tasks in a delegation batch are completed.
	if (delegationTracker) {
		try {
			const completedBatches = await delegationTracker.checkCompleted(teamDir, taskListId);
			for (const batch of completedBatches) {
				const taskRefs = batch.taskIds.map((id) => `#${id}`).join(", ");
				const summary = `All delegated tasks completed (${taskRefs}). Review the results and continue.`;

				try {
					if (ctx.isIdle()) {
						pi.sendUserMessage(`[team] ${summary}`);
					} else {
						pi.sendUserMessage(`[team] ${summary}`, { deliverAs: "followUp" });
					}
				} catch {
					// Fallback: at minimum show a notification so user knows to check.
					ctx.ui.notify(`✅ ${summary}`, "info");
				}
			}
		} catch {
			// Non-fatal: auto-notify is best-effort.
		}
	}
}
