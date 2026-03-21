import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";
import { resolveDisplayStatus, formatElapsed, formatTokens, lastMessageSummary, toolActivity } from "./teams-ui-shared.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { listTasks } from "./task-store.js";

export async function handleTeamListCommand(opts: {
	ctx: ExtensionCommandContext;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	getTracker: () => ActivityTracker;
	style: TeamsStyle;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, teammates, getTeamConfig, getTracker, style, refreshTasks, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	await refreshTasks();

	const teamConfig = getTeamConfig();
	const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
	const cfgByName = new Map<string, TeamMember>();
	for (const m of cfgWorkers) cfgByName.set(m.name, m);

	const names = new Set<string>();
	for (const name of teammates.keys()) names.add(name);
	for (const name of cfgByName.keys()) names.add(name);

	if (names.size === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s`, "info");
		renderWidget();
		return;
	}

	const tracker = getTracker();
	const lines: string[] = [];
	for (const name of Array.from(names).sort()) {
		const rpc = teammates.get(name);
		const cfg = cfgByName.get(name);
		const displayStatus = resolveDisplayStatus(rpc, cfg);
		const kind = rpc ? "rpc" : cfg ? "manual" : "unknown";
		const elapsed = rpc ? formatElapsed(Date.now() - rpc.lastStatusChangeAt) : "";
		const activity = tracker.get(name);
		const tool = toolActivity(activity.currentToolName);
		const elapsedTag = elapsed ? ` ${elapsed}` : "";
		const toolTag = tool ? ` (${tool})` : "";
		lines.push(`${formatMemberDisplayName(style, name)}: ${displayStatus}${elapsedTag}${toolTag} [${kind}]`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
	renderWidget();
}

export async function handleTeamIdCommand(opts: {
	ctx: ExtensionCommandContext;
	teamId: string;
	taskListId: string | null;
	leadName: string;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, teamId, taskListId, leadName, style } = opts;
	const sessionTeamId = ctx.sessionManager.getSessionId();
	const effectiveTlId = taskListId ?? teamId;
	const teamsRoot = getTeamsRootDir();
	const teamDir = getTeamDir(teamId);

	ctx.ui.notify(
		[
			`teamId: ${teamId}`,
			...(teamId !== sessionTeamId ? [`sessionTeamId: ${sessionTeamId}`] : []),
			`taskListId: ${effectiveTlId}`,
			`leadName: ${leadName}`,
			`style: ${style}`,
			`teamsRoot: ${teamsRoot}`,
			`teamDir: ${teamDir}`,
		].join("\n"),
		"info",
	);
}

export async function handleTeamEnvCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	taskListId: string | null;
	leadName: string;
	style: TeamsStyle;
	getTeamsExtensionEntryPath: () => string | null;
	shellQuote: (v: string) => string;
}): Promise<void> {
	const { ctx, rest, teamId, taskListId, leadName, style, getTeamsExtensionEntryPath, shellQuote } = opts;

	const nameRaw = rest[0];
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team env <name>", "error");
		return;
	}

	const name = sanitizeName(nameRaw);
	const effectiveTlId = taskListId ?? teamId;
	const teamsRoot = getTeamsRootDir();
	const teamDir = getTeamDir(teamId);
	const autoClaim = (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1" ? "1" : "0";

	const teamsEntry = getTeamsExtensionEntryPath();
	const piCmd = teamsEntry ? `pi --no-extensions -e ${shellQuote(teamsEntry)}` : "pi";

	const env: Record<string, string> = {
		PI_TEAMS_ROOT_DIR: teamsRoot,
		PI_TEAMS_WORKER: "1",
		PI_TEAMS_TEAM_ID: teamId,
		PI_TEAMS_TASK_LIST_ID: effectiveTlId,
		PI_TEAMS_AGENT_NAME: name,
		PI_TEAMS_LEAD_NAME: leadName,
		PI_TEAMS_STYLE: style,
		PI_TEAMS_AUTO_CLAIM: autoClaim,
	};

	const exportLines = Object.entries(env)
		.map(([k, v]) => `export ${k}=${shellQuote(v)}`)
		.join("\n");

	const oneLiner = Object.entries(env)
		.map(([k, v]) => `${k}=${shellQuote(v)}`)
		.join(" ")
		.concat(` ${piCmd}`);

	ctx.ui.notify(
		[
			`teamId: ${teamId}`,
			`taskListId: ${effectiveTlId}`,
			`leadName: ${leadName}`,
			`teamsRoot: ${teamsRoot}`,
			`teamDir: ${teamDir}`,
			"",
			"Env (copy/paste):",
			exportLines,
			"",
			"Run:",
			oneLiner,
		].join("\n"),
		"info",
	);
}

export async function handleTeamStatusCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	getTracker: () => ActivityTracker;
	teamId: string;
	taskListId: string | null;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, rest, teammates, getTeamConfig, getTracker, teamId, taskListId, style } = opts;
	const strings = getTeamsStrings(style);
	const tracker = getTracker();
	const teamConfig = getTeamConfig();
	const teamDir = getTeamDir(teamId);
	const effectiveTlId = taskListId ?? teamId;

	const nameRaw = rest[0];

	// If no name, show summary of all workers (same as member_status with no name).
	if (!nameRaw) {
		const cfgMembers = teamConfig?.members ?? [];
		const cfgByName = new Map<string, TeamMember>();
		for (const m of cfgMembers) cfgByName.set(m.name, m);

		const workerNames = new Set<string>();
		for (const n of teammates.keys()) workerNames.add(n);
		for (const m of cfgMembers) {
			if (m.role === "worker" && m.status === "online") workerNames.add(m.name);
		}

		if (workerNames.size === 0) {
			ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s`, "info");
			return;
		}

		const lines: string[] = [];
		for (const n of Array.from(workerNames).sort()) {
			const rpc = teammates.get(n);
			const cfg = cfgByName.get(n);
			const displayStatus = resolveDisplayStatus(rpc, cfg);
			const activity = tracker.get(n);
			const elapsed = rpc ? formatElapsed(Date.now() - rpc.lastStatusChangeAt) : "";
			const tool = toolActivity(activity.currentToolName);
			const toolTag = tool ? ` (${tool})` : "";
			const stalledTag = displayStatus === "stalled" ? " ⚠ STALLED" : "";
			lines.push(`${formatMemberDisplayName(style, n)}: ${displayStatus} ${elapsed}${toolTag} · ${formatTokens(activity.totalTokens)} tokens${stalledTag}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Single worker detail view.
	const name = sanitizeName(nameRaw);
	const rpc = teammates.get(name);
	const memberCfg = (teamConfig?.members ?? []).find((m) => m.name === name);
	if (!rpc && !memberCfg) {
		ctx.ui.notify(`Unknown ${strings.memberTitle.toLowerCase()}: ${name}`, "error");
		return;
	}

	const displayStatus = resolveDisplayStatus(rpc, memberCfg);
	const activity = tracker.get(name);
	const elapsed = rpc ? formatElapsed(Date.now() - rpc.lastStatusChangeAt) : "";
	const noEventFor = rpc ? formatElapsed(Date.now() - rpc.lastEventAt) : "";
	const currentTool = toolActivity(activity.currentToolName);
	const msgPreview = lastMessageSummary(rpc, 120);
	const allTasks = await listTasks(teamDir, effectiveTlId);
	const owned = allTasks.filter((t) => t.owner === name);
	const activeTask = owned.find((t) => t.status === "in_progress");
	const model = memberCfg?.meta?.["model"];
	const cwd = memberCfg?.cwd;

	const lines: string[] = [
		`${formatMemberDisplayName(style, name)}: ${displayStatus}`,
		`time in state: ${elapsed || "(unknown)"}`,
		`last event: ${noEventFor || "(unknown)"} ago`,
		`current activity: ${currentTool || "(none)"}`,
		`tool calls: ${activity.toolUseCount} · turns: ${activity.turnCount} · tokens: ${formatTokens(activity.totalTokens)}`,
	];
	if (typeof model === "string" && model) lines.push(`model: ${model}`);
	if (cwd) lines.push(`cwd: ${cwd}`);
	if (activeTask) lines.push(`active task: #${activeTask.id} ${activeTask.subject}`);
	lines.push(`tasks: ${owned.filter((t) => t.status === "pending").length} pending · ${owned.filter((t) => t.status === "in_progress").length} in-progress · ${owned.filter((t) => t.status === "completed").length} completed`);
	if (msgPreview) lines.push(`last message: ${msgPreview}`);
	if (displayStatus === "stalled") {
		lines.push(`⚠ WARNING: no agent events for ${noEventFor} — worker may be stalled`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}
