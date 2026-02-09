import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { cleanupTeamDir } from "./cleanup.js";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { unassignTasksForAgent, type TeamTask } from "./task-store.js";
import { setMemberStatus, setTeamStyle, type TeamConfig } from "./team-config.js";
import { TEAMS_STYLES, type TeamsStyle, getTeamsStrings, formatMemberDisplayName } from "./teams-style.js";
import type { TeammateRpc } from "./teammate-rpc.js";

export async function handleTeamDelegateCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	getDelegateMode: () => boolean;
	setDelegateMode: (next: boolean) => void;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, getDelegateMode, setDelegateMode, renderWidget } = opts;
	const arg = rest[0];
	if (arg === "on") setDelegateMode(true);
	else if (arg === "off") setDelegateMode(false);
	else setDelegateMode(!getDelegateMode());
	ctx.ui.notify(`Delegate mode ${getDelegateMode() ? "ON" : "OFF"}`, "info");
	renderWidget();
}

export async function handleTeamStyleCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamDir: string;
	getStyle: () => TeamsStyle;
	setStyle: (next: TeamsStyle) => void;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamDir, getStyle, setStyle, refreshTasks, renderWidget } = opts;
	const arg = rest[0];
	if (!arg) {
		ctx.ui.notify(`Teams style: ${getStyle()} (set with: /team style <${TEAMS_STYLES.join("|")}>)`, "info");
		return;
	}

	const next: TeamsStyle | null = arg === "normal" || arg === "soviet" ? arg : null;
	if (!next) {
		ctx.ui.notify(`Unknown style: ${arg}. Use one of: ${TEAMS_STYLES.join(", ")}`, "error");
		return;
	}

	setStyle(next);
	await setTeamStyle(teamDir, next);
	await refreshTasks();
	renderWidget();
	ctx.ui.notify(`Teams style set to ${next}`, "info");
}

export async function handleTeamCleanupCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, rest, teammates, refreshTasks, getTasks, renderWidget, style } = opts;
	const strings = getTeamsStrings(style);

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
			`Refusing to cleanup while ${teammates.size} RPC ${strings.memberTitle.toLowerCase()}(s) are running. Stop them first or use --force.`,
			"error",
		);
		return;
	}

	await refreshTasks();
	const tasks = getTasks();
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
}

export async function handleTeamShutdownCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	leadName: string;
	style: TeamsStyle;
	getCurrentCtx: () => ExtensionContext | null;
	stopAllTeammates: (ctx: ExtensionContext, reason: string) => Promise<void>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, getTeamConfig, leadName, style, getCurrentCtx, stopAllTeammates, refreshTasks, getTasks, renderWidget } = opts;
	const strings = getTeamsStrings(style);
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
			from: string;
			timestamp: string;
			reason?: string;
		} = {
			type: "shutdown_request",
			requestId,
			from: leadName,
			timestamp: ts,
			...(reason ? { reason } : {}),
		};

		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: leadName,
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

		ctx.ui.notify(`Shutdown requested for ${formatMemberDisplayName(style, name)}`, "info");

		// Optional fallback for RPC teammates: force stop if it doesn't exit.
		const t = teammates.get(name);
		if (t) {
			setTimeout(() => {
				if (getCurrentCtx()?.sessionManager.getSessionId() !== teamId) return;
				if (t.status === "stopped" || t.status === "error") return;
				void (async () => {
					try {
						await t.stop();
						await setMemberStatus(teamDir, name, "offline", {
							meta: { shutdownFallback: true, shutdownRequestId: requestId },
						});
						getCurrentCtx()?.ui.notify(
							`${formatMemberDisplayName(style, name)} did not comply; ${strings.killedVerb}`,
							"warning",
						);
					} catch {
						// ignore
					}
				})();
			}, 10_000);
		}

		return;
	}

	// /team shutdown (no args) = stop all teammates but keep the leader session alive
	await refreshTasks();
	const cfgBefore = getTeamConfig();
	const cfgWorkersOnline = (cfgBefore?.members ?? []).filter((m) => m.role === "worker" && m.status === "online");

	const activeNames = new Set<string>();
	for (const name of teammates.keys()) activeNames.add(name);
	for (const m of cfgWorkersOnline) activeNames.add(m.name);

	if (activeNames.size === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s to shut down`, "info");
		return;
	}

	if (process.stdout.isTTY && process.stdin.isTTY) {
		const msg =
			style === "soviet"
				? `Dismiss all ${strings.memberTitle.toLowerCase()}s from the ${strings.teamNoun}?`
				: `Stop all ${String(activeNames.size)} teammate${activeNames.size === 1 ? "" : "s"}?`;
		const ok = await ctx.ui.confirm("Shutdown team", msg);
		if (!ok) return;
	}

	const reason =
		style === "soviet"
			? `The ${strings.teamNoun} is dissolved by the chairman`
			: "Stopped by /team shutdown";
	// Stop RPC teammates we own
	await stopAllTeammates(ctx, reason);

	// Best-effort: ask *manual* workers (persisted in config.json) to shut down too.
	// Also mark them offline so they stop cluttering the UI if they were left behind from old runs.
	await refreshTasks();
	const cfg = getTeamConfig();
	const teamId = ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);

	const inProgressOwners = new Set<string>();
	for (const t of getTasks()) {
		if (t.owner && t.status === "in_progress") inProgressOwners.add(t.owner);
	}

	const manualWorkers = (cfg?.members ?? []).filter((m) => m.role === "worker" && m.status === "online");
	for (const m of manualWorkers) {
		// If it's an RPC teammate we already stopped above, skip mailbox request.
		if (teammates.has(m.name)) continue;
		// If a manual worker still owns an in-progress task, don't force it offline in the UI.
		if (inProgressOwners.has(m.name)) continue;

		const requestId = randomUUID();
		const ts = new Date().toISOString();
		try {
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, m.name, {
				from: leadName,
				text: JSON.stringify({
					type: "shutdown_request",
					requestId,
					from: leadName,
					timestamp: ts,
					reason,
				}),
				timestamp: ts,
			});
		} catch {
			// ignore mailbox errors
		}

		void setMemberStatus(teamDir, m.name, "offline", {
			meta: { shutdownRequestedAt: ts, shutdownRequestId: requestId, stoppedReason: reason },
		});
	}

	renderWidget();
	ctx.ui.notify(
		`Team ended: all ${strings.memberTitle.toLowerCase()}s stopped (leader session remains active)`,
		"info",
	);
}

export async function handleTeamPruneCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	style: TeamsStyle;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, getTeamConfig, refreshTasks, getTasks, style, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	const flags = rest.filter((a) => a.startsWith("--"));
	const argsOnly = rest.filter((a) => !a.startsWith("--"));
	const all = flags.includes("--all");
	const unknownFlags = flags.filter((f) => f !== "--all");
	if (unknownFlags.length) {
		ctx.ui.notify(`Unknown flag(s): ${unknownFlags.join(", ")}`, "error");
		return;
	}
	if (argsOnly.length) {
		ctx.ui.notify("Usage: /team prune [--all]", "error");
		return;
	}

	await refreshTasks();
	const cfg = getTeamConfig();
	const members = (cfg?.members ?? []).filter((m) => m.role === "worker");
	if (!members.length) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s to prune`, "info");
		renderWidget();
		return;
	}

	const inProgressOwners = new Set<string>();
	for (const t of getTasks()) {
		if (t.owner && t.status === "in_progress") inProgressOwners.add(t.owner);
	}

	const cutoffMs = 60 * 60 * 1000; // 1h
	const now = Date.now();

	const pruned: string[] = [];
	for (const m of members) {
		if (teammates.has(m.name)) continue; // still tracked as RPC
		if (inProgressOwners.has(m.name)) continue; // still actively working
		if (!all) {
			const lastSeen = m.lastSeenAt ? Date.parse(m.lastSeenAt) : NaN;
			if (!Number.isFinite(lastSeen)) continue;
			if (now - lastSeen < cutoffMs) continue;
		}

		const teamId = ctx.sessionManager.getSessionId();
		const teamDir = getTeamDir(teamId);
		await setMemberStatus(teamDir, m.name, "offline", {
			meta: { prunedAt: new Date().toISOString(), prunedBy: "leader" },
		});
		pruned.push(m.name);
	}

	await refreshTasks();
	renderWidget();
	ctx.ui.notify(
		pruned.length
			? `Pruned ${pruned.length} stale ${strings.memberTitle.toLowerCase()}(s): ${pruned.join(", ")}`
			: `No stale ${strings.memberTitle.toLowerCase()}s to prune (use --all to force)`,
		"info",
	);
}

export async function handleTeamStopCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	leadName: string;
	style: TeamsStyle;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, leadName, style, refreshTasks, getTasks, renderWidget } = opts;

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
	const tasks = getTasks();
	const active = tasks.find((x) => x.owner === name && x.status === "in_progress");
	const taskId = active?.id;

	const ts = new Date().toISOString();
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
		from: leadName,
		text: JSON.stringify({
			type: "abort_request",
			requestId: randomUUID(),
			from: leadName,
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
		`Abort requested for ${formatMemberDisplayName(style, name)}${taskId ? ` (task #${taskId})` : ""}${t ? "" : " (mailbox only)"}`,
		"warning",
	);
	renderWidget();
}

export async function handleTeamKillCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	leadName: string;
	style: TeamsStyle;
	taskListId: string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, taskListId, leadName: _leadName, style, refreshTasks, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	const nameRaw = rest[0];
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team kill <name>", "error");
		return;
	}
	const name = sanitizeName(nameRaw);
	const t = teammates.get(name);
	if (!t) {
		ctx.ui.notify(`Unknown ${strings.memberTitle.toLowerCase()}: ${name}`, "error");
		return;
	}

	await t.stop();
	teammates.delete(name);

	const teamId = ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const effectiveTlId = taskListId ?? teamId;
	await unassignTasksForAgent(teamDir, effectiveTlId, name, `${formatMemberDisplayName(style, name)} ${strings.killedVerb}`);
	await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });

	ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)`, "warning");
	await refreshTasks();
	renderWidget();
}
