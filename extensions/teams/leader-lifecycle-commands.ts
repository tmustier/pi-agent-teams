import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { cleanupTeamDir, gcStaleTeamDirs } from "./cleanup.js";
import { writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir, getTeamsStylesDir } from "./paths.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import { unassignTasksForAgent, type TeamTask } from "./task-store.js";
import { setMemberStatus, setTeamStyle, type TeamConfig } from "./team-config.js";
import {
	type TeamsStyle,
	formatMemberDisplayName,
	getTeamsStrings,
	listAvailableTeamsStyles,
	normalizeTeamsStyleId,
	resolveTeamsStyleDefinition,
	formatTeamsTemplate,
} from "./teams-style.js";
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
	const argRaw = rest[0];
	if (!argRaw) {
		ctx.ui.notify(
			"Teams style:\n" +
				`  current: ${getStyle()}\n` +
				"  list:   /team style list\n" +
				"  set:    /team style <name>\n" +
				"  init:   /team style init <name> [extends <base>]",
			"info",
		);
		return;
	}

	if (argRaw === "list") {
		const { dir, all, builtins, customs } = listAvailableTeamsStyles();
		ctx.ui.notify(
			[
				"Available team styles:",
				"",
				`built-in: ${builtins.join(", ")}`,
				customs.length ? `custom:   ${customs.join(", ")}` : "custom:   (none)",
				"",
				"To add a custom style, create a JSON file:",
				`  ${dir}/<style>.json`,
				"",
				`All: ${all.join(", ")}`,
			].join("\n"),
			"info",
		);
		return;
	}

	if (argRaw === "init") {
		const nameRaw = rest[1];
		const styleId = normalizeTeamsStyleId(nameRaw);
		if (!styleId) {
			ctx.ui.notify("Usage: /team style init <name> [extends <base>]", "error");
			return;
		}

		let extendsRaw: string | undefined;
		if (rest[2] === "extends") extendsRaw = rest[3];
		else extendsRaw = rest[2];
		const extendsId = normalizeTeamsStyleId(extendsRaw) ?? "normal";

		try {
			resolveTeamsStyleDefinition(extendsId, { strict: true });
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}

		const dir = getTeamsStylesDir();
		const file = path.join(dir, `${styleId}.json`);
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			const base = resolveTeamsStyleDefinition(extendsId);
			const template = {
				extends: extendsId,
				strings: base.strings,
				naming: base.naming,
			};
			await fs.promises.writeFile(file, JSON.stringify(template, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to create style file: ${file}\n${msg}`, "error");
			return;
		}

		ctx.ui.notify(
			[
				"Created style template:",
				`  ${file}`,
				"",
				"Edit it, then activate with:",
				`  /team style ${styleId}`,
			].join("\n"),
			"info",
		);
		return;
	}

	const next = normalizeTeamsStyleId(argRaw);
	if (!next) {
		ctx.ui.notify("Usage: /team style <name> | /team style list | /team style init <name>", "error");
		return;
	}

	try {
		// Validate that the style exists (built-in or custom file). Falls back to throwing with a useful message.
		resolveTeamsStyleDefinition(next, { strict: true });
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
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
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, refreshTasks, getTasks, renderWidget, style } = opts;
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
		const result = await cleanupTeamDir(teamsRoot, teamDir, { teamId, repoCwd: ctx.cwd });
		const parts: string[] = [`Cleaned up team directory: ${teamDir}`];
		if (result.worktreeResult.removedWorktrees.length > 0) {
			parts.push(`Removed ${result.worktreeResult.removedWorktrees.length} worktree(s)`);
		}
		if (result.worktreeResult.removedBranches.length > 0) {
			parts.push(`Removed ${result.worktreeResult.removedBranches.length} branch(es)`);
		}
		for (const w of result.warnings) {
			parts.push(`⚠ ${w}`);
		}
		ctx.ui.notify(parts.join("\n"), "warning");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}

	await refreshTasks();
	renderWidget();
}

export async function handleTeamShutdownCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	leadName: string;
	style: TeamsStyle;
	getCurrentCtx: () => ExtensionContext | null;
	getActiveTeamId: () => string;
	stopAllTeammates: (ctx: ExtensionContext, reason: string) => Promise<void>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, getTeamConfig, leadName, style, getCurrentCtx, getActiveTeamId, stopAllTeammates, refreshTasks, getTasks, renderWidget } = opts;
	const strings = getTeamsStrings(style);
	const nameRaw = rest[0];

	// /team shutdown <name> [reason...] = request graceful worker shutdown via mailbox
	if (nameRaw) {
		const name = sanitizeName(nameRaw);
		const reason = rest.slice(1).join(" ").trim() || undefined;

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

		ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.shutdownRequestedVerb}`, "info");

		// Optional fallback for RPC teammates: force stop if it doesn't exit.
		const t = teammates.get(name);
		if (t) {
			setTimeout(() => {
				if (getActiveTeamId() !== teamId) return;
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
		const members = `${strings.memberTitle.toLowerCase()}s`;
		ctx.ui.notify(formatTeamsTemplate(strings.noMembersToShutdown, { members, count: "0" }), "info");
		return;
	}

	if (process.stdout.isTTY && process.stdin.isTTY) {
		const plural = activeNames.size === 1 ? "" : "s";
		const members = `${strings.memberTitle.toLowerCase()}${plural}`;
		const msg = formatTeamsTemplate(strings.shutdownAllPrompt, {
			count: String(activeNames.size),
			members,
		});
		const ok = await ctx.ui.confirm("Shutdown team", msg);
		if (!ok) return;
	}

	const reason = "Stopped by /team shutdown";
	// Stop RPC teammates we own
	await stopAllTeammates(ctx, reason);

	// Best-effort: ask *manual* workers (persisted in config.json) to shut down too.
	// Also mark them offline so they stop cluttering the UI if they were left behind from old runs.
	await refreshTasks();
	const cfg = getTeamConfig();
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
	const members = `${strings.memberTitle.toLowerCase()}s`;
	ctx.ui.notify(formatTeamsTemplate(strings.teamEndedAllStopped, { members, count: String(activeNames.size) }), "info");
}

export async function handleTeamPruneCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	style: TeamsStyle;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, getTeamConfig, refreshTasks, getTasks, style, renderWidget } = opts;
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
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	leadName: string;
	style: TeamsStyle;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, leadName, style, refreshTasks, getTasks, renderWidget } = opts;

	const nameRaw = rest[0];
	const reason = rest.slice(1).join(" ").trim();
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team stop <name> [reason...]", "error");
		return;
	}
	const name = sanitizeName(nameRaw);

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

	let msg = `${formatMemberDisplayName(style, name)} ${getTeamsStrings(style).abortRequestedVerb}`;
	if (taskId) msg += ` (task #${taskId})`;
	if (!t) msg += " (mailbox only)";
	ctx.ui.notify(msg, "warning");
	renderWidget();
}

/**
 * `/team done` — end-of-run cleanup.
 *
 * Stops all teammates, hides the widget, and optionally cleans up team artifacts.
 * This is the "team is finished" ergonomic counterpart to `/team cleanup`.
 *
 * Behavior:
 * 1. Stops all RPC teammates (graceful, no confirmation prompt).
 * 2. Marks all config-only workers offline.
 * 3. Hides the Teams widget.
 * 4. Notifies the user with a summary.
 *
 * Use `/team cleanup [--force]` afterward if you also want to delete task/mailbox files.
 */
export async function handleTeamDoneCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	leadName: string;
	style: TeamsStyle;
	stopAllTeammates: (ctx: ExtensionContext, reason: string) => Promise<void>;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
	hideWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, getTeamConfig, leadName, style, stopAllTeammates, refreshTasks, getTasks, hideWidget } = opts;
	const strings = getTeamsStrings(style);

	const flags = rest.filter((a) => a.startsWith("--"));
	const unknownFlags = flags.filter((f) => f !== "--force");
	if (unknownFlags.length) {
		ctx.ui.notify(`Unknown flag(s): ${unknownFlags.join(", ")}`, "error");
		return;
	}

	await refreshTasks();
	const tasks = getTasks();
	const inProgress = tasks.filter((t) => t.status === "in_progress");

	if (inProgress.length > 0 && !flags.includes("--force")) {
		ctx.ui.notify(
			`${inProgress.length} task(s) still in progress. Use /team done --force to end anyway.`,
			"error",
		);
		return;
	}

	// Stop all RPC teammates
	const reason = formatTeamsTemplate(strings.teamEndedAllStopped, {
		members: `${strings.memberTitle.toLowerCase()}s`,
		count: String(teammates.size),
	});
	await stopAllTeammates(ctx, reason);

	// Mark manual/config workers offline
	const cfg = getTeamConfig();
	const teamDir = getTeamDir(teamId);
	const manualWorkers = (cfg?.members ?? []).filter((m) => m.role === "worker" && m.status === "online");
	for (const m of manualWorkers) {
		if (teammates.has(m.name)) continue;
		const ts = new Date().toISOString();
		try {
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, m.name, {
				from: leadName,
				text: JSON.stringify({
					type: "shutdown_request",
					requestId: randomUUID(),
					from: leadName,
					timestamp: ts,
					reason: "Team done",
				}),
				timestamp: ts,
			});
		} catch {
			// ignore
		}
		await setMemberStatus(teamDir, m.name, "offline", {
			meta: { stoppedReason: "team-done", stoppedAt: ts },
		});
	}

	// Unassign any in-progress tasks (force mode)
	if (inProgress.length > 0) {
		for (const task of inProgress) {
			if (task.owner) {
				await unassignTasksForAgent(teamDir, cfg?.taskListId ?? teamId, task.owner, "team done");
			}
		}
	}

	await refreshTasks();

	// Hide the widget
	hideWidget();

	// Summary
	const completed = tasks.filter((t) => t.status === "completed").length;
	const pending = tasks.filter((t) => t.status === "pending").length;
	const total = tasks.length;

	const summaryParts = [`Team done. ${total} task(s): ${completed} completed`];
	if (pending > 0) summaryParts.push(`${pending} pending`);
	if (inProgress.length > 0) summaryParts.push(`${inProgress.length} were in-progress (unassigned)`);
	summaryParts.push("Widget hidden. Use /team cleanup to remove artifacts.");

	ctx.ui.notify(summaryParts.join(", ") + ".", "info");
}

export async function handleTeamKillCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	teammates: Map<string, TeammateRpc>;
	leadName: string;
	style: TeamsStyle;
	taskListId: string | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, rest, teamId, teammates, taskListId, leadName: _leadName, style, refreshTasks, renderWidget } = opts;
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

	const teamDir = getTeamDir(teamId);
	const effectiveTlId = taskListId ?? teamId;
	await unassignTasksForAgent(teamDir, effectiveTlId, name, `${formatMemberDisplayName(style, name)} ${strings.killedVerb}`);
	await setMemberStatus(teamDir, name, "offline", { meta: { killedAt: new Date().toISOString() } });

	ctx.ui.notify(`${formatMemberDisplayName(style, name)} ${strings.killedVerb} (SIGTERM)`, "warning");
	await refreshTasks();
	renderWidget();
}

const DEFAULT_GC_MAX_AGE_HOURS = 24;

export async function handleTeamGcCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
}): Promise<void> {
	const { ctx, rest } = opts;

	const flags = rest.filter((a) => a.startsWith("--"));
	const argsOnly = rest.filter((a) => !a.startsWith("--"));
	const dryRun = flags.includes("--dry-run");
	const force = flags.includes("--force");

	const unknownFlags = flags.filter((f) => f !== "--dry-run" && f !== "--force" && !f.startsWith("--max-age-hours="));
	if (unknownFlags.length) {
		ctx.ui.notify(`Unknown flag(s): ${unknownFlags.join(", ")}`, "error");
		return;
	}
	if (argsOnly.length) {
		ctx.ui.notify("Usage: /team gc [--dry-run] [--force] [--max-age-hours=N]", "error");
		return;
	}

	// Parse --max-age-hours=N
	let maxAgeHours = DEFAULT_GC_MAX_AGE_HOURS;
	const maxAgeFlag = flags.find((f) => f.startsWith("--max-age-hours="));
	if (maxAgeFlag) {
		const val = Number(maxAgeFlag.split("=")[1]);
		if (!Number.isFinite(val) || val < 0) {
			ctx.ui.notify("--max-age-hours must be a non-negative number", "error");
			return;
		}
		maxAgeHours = val;
	}

	const teamsRoot = getTeamsRootDir();
	const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

	if (!force && !dryRun) {
		if (process.stdout.isTTY && process.stdin.isTTY) {
			const ok = await ctx.ui.confirm(
				"Garbage collect teams",
				`Remove all stale team directories older than ${maxAgeHours}h?\nTeams root: ${teamsRoot}`,
			);
			if (!ok) return;
		} else {
			ctx.ui.notify("Use --force or --dry-run in non-interactive mode", "error");
			return;
		}
	}

	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs,
		repoCwd: ctx.cwd,
		dryRun,
	});

	const lines: string[] = [];
	if (dryRun) {
		lines.push(`[DRY RUN] Would remove ${result.removed.length} of ${result.scanned} team dirs`);
	} else {
		lines.push(`Removed ${result.removed.length} of ${result.scanned} team dirs`);
	}
	if (result.skipped.length > 0) {
		const byReason = new Map<string, number>();
		for (const s of result.skipped) {
			byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [reason, count] of byReason) {
			parts.push(`${count} ${reason}`);
		}
		lines.push(`Skipped: ${parts.join(", ")}`);
	}
	for (const w of result.warnings) {
		lines.push(`⚠ ${w}`);
	}

	ctx.ui.notify(lines.join("\n"), dryRun ? "info" : "warning");
}
