import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { cleanupTeamDir } from "./cleanup.js";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { unassignTasksForAgent, type TeamTask } from "./task-store.js";
import { setMemberStatus } from "./team-config.js";
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

export async function handleTeamCleanupCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, refreshTasks, getTasks, renderWidget } = opts;

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
			`Refusing to cleanup while ${teammates.size} RPC comrade(s) are running. Stop them first or use --force.`,
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
	getCurrentCtx: () => ExtensionCommandContext | null;
}): Promise<void> {
	const { ctx, rest, teammates, getCurrentCtx } = opts;
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
			from: "chairman";
			timestamp: string;
			reason?: string;
		} = {
			type: "shutdown_request",
			requestId,
			from: "chairman",
			timestamp: ts,
			...(reason ? { reason } : {}),
		};

		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, name, {
			from: "chairman",
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

		ctx.ui.notify(`Shutdown requested for ${name}`, "info");

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
						getCurrentCtx()?.ui.notify(`Shutdown timeout; killed ${name}`, "warning");
					} catch {
						// ignore
					}
				})();
			}, 10_000);
		}

		return;
	}

	// /team shutdown (no args) = shutdown leader + all teammates
	// Only prompt in interactive TTY mode. In RPC mode, confirm() would require
	// the host to send extension_ui_response messages.
	if (process.stdout.isTTY && process.stdin.isTTY) {
		const ok = await ctx.ui.confirm("Shutdown", "Exit pi and stop all comrades?");
		if (!ok) return;
	}
	// In RPC mode, shutdown is deferred until the next input line is handled.
	// Teammates are stopped in the session_shutdown handler.
	ctx.ui.notify("Shutdown requested", "info");
	ctx.shutdown();
}

export async function handleTeamStopCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, refreshTasks, getTasks, renderWidget } = opts;

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
		from: "chairman",
		text: JSON.stringify({
			type: "abort_request",
			requestId: randomUUID(),
			from: "chairman",
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
		`Abort requested for ${name}${taskId ? ` (task #${taskId})` : ""}${t ? "" : " (mailbox only)"}`,
		"warning",
	);
	renderWidget();
}

export async function handleTeamKillCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	taskListId: string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teammates, taskListId, refreshTasks, renderWidget } = opts;

	const nameRaw = rest[0];
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team kill <name>", "error");
		return;
	}
	const name = sanitizeName(nameRaw);
	const t = teammates.get(name);
	if (!t) {
		ctx.ui.notify(`Unknown comrade: ${name}`, "error");
		return;
	}

	await t.stop();
	teammates.delete(name);

	const teamId = ctx.sessionManager.getSessionId();
	const teamDir = getTeamDir(teamId);
	const effectiveTlId = taskListId ?? teamId;
	await unassignTasksForAgent(teamDir, effectiveTlId, name, `Killed comrade '${name}'`);
	await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });

	ctx.ui.notify(`Killed comrade ${name}`, "warning");
	await refreshTasks();
	renderWidget();
}
