import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getTeamDir } from "./paths.js";
import {
	acquireTeamAttachClaim,
	releaseTeamAttachClaim,
	TEAM_ATTACH_CLAIM_STALE_MS,
} from "./team-attach-claim.js";
import { loadTeamConfig } from "./team-config.js";
import { listDiscoveredTeams } from "./team-discovery.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamsStyle } from "./teams-style.js";

function formatClaimAge(heartbeatAt?: string): string {
	if (!heartbeatAt) return "unknown";
	const heartbeatMs = Date.parse(heartbeatAt);
	if (!Number.isFinite(heartbeatMs)) return "unknown";
	const ageMs = Math.max(0, Date.now() - heartbeatMs);
	const ageSec = Math.floor(ageMs / 1000);
	return `${ageSec}s`;
}

export async function handleTeamAttachCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	defaultTeamId: string;
	teammates: Map<string, TeammateRpc>;
	getActiveTeamId: () => string;
	setActiveTeamId: (teamId: string) => void;
	setStyle: (style: TeamsStyle) => void;
	setTaskListId: (id: string) => void;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	restoreWidget: () => void;
}): Promise<void> {
	const {
		ctx,
		rest,
		defaultTeamId,
		teammates,
		getActiveTeamId,
		setActiveTeamId,
		setStyle,
		setTaskListId,
		refreshTasks,
		restoreWidget,
	} = opts;

	const tokens = rest.map((t) => t.trim()).filter((t) => t.length > 0);
	const activeTeamId = getActiveTeamId();
	if (tokens.length === 0 || tokens[0] === "help") {
		ctx.ui.notify(
			[
				"Usage:",
				"  /team attach list",
				"  /team attach <teamId> [--claim]",
				"",
				`current: ${activeTeamId}${activeTeamId === defaultTeamId ? " (session)" : " (attached)"}`,
				`session: ${defaultTeamId}`,
			].join("\n"),
			"info",
		);
		return;
	}

	if (tokens[0] === "list") {
		const teams = await listDiscoveredTeams();
		if (teams.length === 0) {
			ctx.ui.notify("No existing teams found", "info");
			return;
		}

		const lines: string[] = ["Known teams:"];
		for (const t of teams.slice(0, 30)) {
			const marks: string[] = [];
			if (t.teamId === activeTeamId) marks.push("current");
			if (t.teamId === defaultTeamId) marks.push("session");
			if (t.attachedBySessionId) {
				const ownerMark = t.attachedBySessionId === defaultTeamId ? "claimed:you" : `claimed:${t.attachedBySessionId}`;
				const staleMark = t.attachClaimStale ? "stale" : "live";
				const age = formatClaimAge(t.attachHeartbeatAt);
				marks.push(`${ownerMark}:${staleMark}:${age}`);
			}
			const mark = marks.length ? ` [${marks.join(",")}]` : "";
			lines.push(
				`- ${t.teamId}${mark} · style=${t.style} · workers=${t.onlineWorkerCount}/${t.workerCount} · taskList=${t.taskListId}`,
			);
		}
		if (teams.length > 30) lines.push(`... +${teams.length - 30} more`);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const unknownFlags = tokens.filter((t) => t.startsWith("--") && t !== "--claim");
	if (unknownFlags.length > 0) {
		ctx.ui.notify(`Unknown attach flag(s): ${unknownFlags.join(", ")}`, "error");
		return;
	}
	const forceClaim = tokens.includes("--claim");
	const positional = tokens.filter((t) => !t.startsWith("--"));
	const targetTeamId = positional[0]?.trim() ?? "";
	if (!targetTeamId || positional.length !== 1) {
		ctx.ui.notify("Usage: /team attach <teamId> [--claim]", "error");
		return;
	}
	if (targetTeamId === activeTeamId) {
		ctx.ui.notify(`Already attached to team: ${targetTeamId}`, "info");
		return;
	}

	if (teammates.size > 0) {
		ctx.ui.notify(
			`Refusing to attach while ${teammates.size} RPC teammate(s) are running. Run /team shutdown first.`,
			"error",
		);
		return;
	}

	const targetDir = getTeamDir(targetTeamId);
	const cfg = await loadTeamConfig(targetDir);
	if (!cfg) {
		ctx.ui.notify(`Team not found: ${targetTeamId}\nExpected config at: ${targetDir}/config.json`, "error");
		return;
	}

	if (process.stdout.isTTY && process.stdin.isTTY) {
		const ok = await ctx.ui.confirm(
			"Attach to team",
			[
				`Attach this session to team ${cfg.teamId}?`,
				"",
				`taskListId: ${cfg.taskListId}`,
				`style: ${cfg.style ?? "normal"}`,
				`workers: ${cfg.members.filter((m) => m.role === "worker").length}`,
				forceClaim ? "mode: force-claim" : "mode: normal claim",
			].join("\n"),
		);
		if (!ok) return;
	}

	const claimResult = await acquireTeamAttachClaim(targetDir, defaultTeamId, {
		force: forceClaim,
		staleMs: TEAM_ATTACH_CLAIM_STALE_MS,
	});
	if (!claimResult.ok) {
		const heldFor = formatClaimAge(claimResult.claim.heartbeatAt);
		ctx.ui.notify(
			[
				`Team ${cfg.teamId} is currently claimed by session ${claimResult.claim.holderSessionId}.`,
				`last heartbeat: ${heldFor} ago`,
				"Run '/team attach <teamId> --claim' to force takeover.",
			].join("\n"),
			"error",
		);
		return;
	}

	const previouslyAttachedTeamId = activeTeamId !== defaultTeamId ? activeTeamId : null;
	if (previouslyAttachedTeamId && previouslyAttachedTeamId !== cfg.teamId) {
		const previousDir = getTeamDir(previouslyAttachedTeamId);
		await releaseTeamAttachClaim(previousDir, defaultTeamId);
	}

	setActiveTeamId(cfg.teamId);
	setTaskListId(cfg.taskListId);
	setStyle(cfg.style ?? "normal");
	await refreshTasks();
	// Clear any /team done suppression — attaching to a team is explicit intent to work.
	restoreWidget();

	const lines: string[] = [
		`Attached to team: ${cfg.teamId}`,
		`taskListId: ${cfg.taskListId}`,
		`style: ${cfg.style ?? "normal"}`,
	];
	if (claimResult.replacedClaim && claimResult.replacedClaim.holderSessionId !== defaultTeamId) {
		lines.push(`claim: took over from ${claimResult.replacedClaim.holderSessionId}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

export async function handleTeamDetachCommand(opts: {
	ctx: ExtensionCommandContext;
	defaultTeamId: string;
	teammates: Map<string, TeammateRpc>;
	getActiveTeamId: () => string;
	setActiveTeamId: (teamId: string) => void;
	setTaskListId: (id: string) => void;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	restoreWidget: () => void;
}): Promise<void> {
	const { ctx, defaultTeamId, teammates, getActiveTeamId, setActiveTeamId, setTaskListId, refreshTasks, restoreWidget } = opts;

	const activeTeamId = getActiveTeamId();
	if (activeTeamId === defaultTeamId) {
		ctx.ui.notify("Already using this session's team", "info");
		return;
	}
	if (teammates.size > 0) {
		ctx.ui.notify(
			`Refusing to detach while ${teammates.size} RPC teammate(s) are running. Run /team shutdown first.`,
			"error",
		);
		return;
	}

	const activeDir = getTeamDir(activeTeamId);
	const releaseResult = await releaseTeamAttachClaim(activeDir, defaultTeamId);

	setActiveTeamId(defaultTeamId);
	setTaskListId(defaultTeamId);
	await refreshTasks();
	// Clear any /team done suppression — returning to own team.
	restoreWidget();

	if (releaseResult === "not_owner") {
		ctx.ui.notify(
			`Detached from external team ${activeTeamId}, but attach claim belonged to another session.`,
			"warning",
		);
		return;
	}

	ctx.ui.notify(`Detached from external team. Back to session team: ${defaultTeamId}`, "info");
}
