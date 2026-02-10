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

import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

export async function pollLeaderInbox(opts: {
	ctx: ExtensionContext;
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
}): Promise<void> {
	const { ctx, teamId, teamDir, taskListId, leadName, style, pendingPlanApprovals } = opts;
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

		ctx.ui.notify(`Message from ${m.from}: ${m.text}`, "info");
	}
}
