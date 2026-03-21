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
import { getTask, listTasks } from "./task-store.js";

import type { TeamsHookInvocation } from "./hooks.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

/** Callback to inject a message into the leader LLM conversation. */
export type SendLeaderLlmMessage = (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;

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
}): Promise<void> {
	const { ctx, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals, enqueueHook, sendLeaderLlmMessage } = opts;
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
						}

						sendLeaderLlmMessage(lines.join("\n"), { deliverAs: "followUp" });
					}
				} else {
					ctx.ui.notify(`${name} is idle`, "info");
				}
			}
			continue;
		}

		ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
	}
}
