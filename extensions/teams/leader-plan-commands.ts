import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName } from "./teams-style.js";

export async function handleTeamPlanCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	leadName: string;
	style: TeamsStyle;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
}): Promise<void> {
	const { ctx, rest, leadName, style, pendingPlanApprovals } = opts;

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
			from: leadName,
			text: JSON.stringify({
				type: "plan_approved",
				requestId: pending.requestId,
				from: leadName,
				timestamp: ts,
			}),
			timestamp: ts,
		});
		pendingPlanApprovals.delete(name);
		ctx.ui.notify(`Approved plan for ${formatMemberDisplayName(style, name)}`, "info");
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
			from: leadName,
			text: JSON.stringify({
				type: "plan_rejected",
				requestId: pending.requestId,
				from: leadName,
				feedback,
				timestamp: ts,
			}),
			timestamp: ts,
		});
		pendingPlanApprovals.delete(name);
		ctx.ui.notify(`Rejected plan for ${formatMemberDisplayName(style, name)}: ${feedback}`, "info");
		return;
	}

	ctx.ui.notify(`Unknown plan subcommand: ${planSub}`, "error");
}
