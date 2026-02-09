import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir } from "./paths.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { ensureTeamConfig } from "./team-config.js";
import type { TeamTask } from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

export async function handleTeamSendCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	style: TeamsStyle;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, style, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	const nameRaw = rest[0];
	const msg = rest.slice(1).join(" ").trim();
	if (!nameRaw || !msg) {
		ctx.ui.notify("Usage: /team send <name> <msg...>", "error");
		return;
	}
	const name = sanitizeName(nameRaw);
	const t = teammates.get(name);
	if (!t) {
		ctx.ui.notify(`Unknown ${strings.memberTitle.toLowerCase()}: ${name}`, "error");
		return;
	}
	if (t.status === "streaming") await t.followUp(msg);
	else await t.prompt(msg);
	ctx.ui.notify(`Sent to ${name}`, "info");
	renderWidget();
}

export async function handleTeamSteerCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	style: TeamsStyle;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, style, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	const nameRaw = rest[0];
	const msg = rest.slice(1).join(" ").trim();
	if (!nameRaw || !msg) {
		ctx.ui.notify("Usage: /team steer <name> <msg...>", "error");
		return;
	}
	const name = sanitizeName(nameRaw);
	const t = teammates.get(name);
	if (!t) {
		ctx.ui.notify(`Unknown ${strings.memberTitle.toLowerCase()}: ${name}`, "error");
		return;
	}
	await t.steer(msg);
	ctx.ui.notify(`Steering sent to ${name}`, "info");
	renderWidget();
}

export async function handleTeamDmCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	leadName: string;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, rest, leadName, style } = opts;

	const nameRaw = rest[0];
	const msg = rest.slice(1).join(" ").trim();
	if (!nameRaw || !msg) {
		ctx.ui.notify("Usage: /team dm <name> <msg...>", "error");
		return;
	}
	const name = sanitizeName(nameRaw);
	const teamId = ctx.sessionManager.getSessionId();
	await writeToMailbox(getTeamDir(teamId), TEAM_MAILBOX_NS, name, {
		from: leadName,
		text: msg,
		timestamp: new Date().toISOString(),
	});
	ctx.ui.notify(`DM queued for ${formatMemberDisplayName(style, name)}`, "info");
}

export async function handleTeamBroadcastCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	leadName: string;
	style: TeamsStyle;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	getTaskListId: () => string | null;
}): Promise<void> {
	const { ctx, rest, teammates, leadName, style, refreshTasks, getTasks, getTaskListId } = opts;
	const strings = getTeamsStrings(style);

	const msg = rest.join(" ").trim();
	if (!msg) {
		ctx.ui.notify("Usage: /team broadcast <msg...>", "error");
		return;
	}

	const teamId = ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const taskListId = getTaskListId();
	const cfg = await ensureTeamConfig(teamDir, { teamId, taskListId: taskListId ?? teamId, leadName, style });

	const recipients = new Set<string>();
	for (const m of cfg.members) {
		if (m.role === "worker") recipients.add(m.name);
	}
	for (const name of teammates.keys()) recipients.add(name);

	// Include task owners (helps reach manual tmux workers not tracked as RPC teammates).
	await refreshTasks();
	for (const t of getTasks()) {
		if (t.owner && t.owner !== leadName) recipients.add(t.owner);
	}

	const names = Array.from(recipients).sort();
	if (names.length === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s to broadcast to`, "warning");
		return;
	}

	const ts = new Date().toISOString();
	await Promise.all(
		names.map((name) =>
			writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
				from: leadName,
				text: msg,
				timestamp: ts,
			}),
		),
	);

	ctx.ui.notify(
		`Broadcast queued for ${names.length} ${strings.memberTitle.toLowerCase()}(s): ${names.map((n) => formatMemberDisplayName(style, n)).join(", ")}`,
		"info",
	);
}
