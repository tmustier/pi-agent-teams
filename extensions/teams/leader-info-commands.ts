import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamConfig, TeamMember } from "./team-config.js";

export async function handleTeamListCommand(opts: {
	ctx: ExtensionCommandContext;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, teammates, getTeamConfig, refreshTasks, renderWidget } = opts;

	await refreshTasks();

	const teamConfig = getTeamConfig();
	const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
	const cfgByName = new Map<string, TeamMember>();
	for (const m of cfgWorkers) cfgByName.set(m.name, m);

	const names = new Set<string>();
	for (const name of teammates.keys()) names.add(name);
	for (const name of cfgByName.keys()) names.add(name);

	if (names.size === 0) {
		ctx.ui.notify("No teammates", "info");
		renderWidget();
		return;
	}

	const lines: string[] = [];
	for (const name of Array.from(names).sort()) {
		const rpc = teammates.get(name);
		const cfg = cfgByName.get(name);
		const status = rpc ? rpc.status : cfg?.status ?? "offline";
		const kind = rpc ? "rpc" : cfg ? "manual" : "unknown";
		lines.push(`${name}: ${status} (${kind})`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
	renderWidget();
}

export async function handleTeamIdCommand(opts: {
	ctx: ExtensionCommandContext;
	taskListId: string | null;
}): Promise<void> {
	const { ctx, taskListId } = opts;

	const teamId = ctx.sessionManager.getSessionId();
	const effectiveTlId = taskListId ?? teamId;
	const leadName = "team-lead";
	const teamsRoot = getTeamsRootDir();
	const teamDir = getTeamDir(teamId);

	ctx.ui.notify(
		[
			`teamId: ${teamId}`,
			`taskListId: ${effectiveTlId}`,
			`leadName: ${leadName}`,
			`teamsRoot: ${teamsRoot}`,
			`teamDir: ${teamDir}`,
		].join("\n"),
		"info",
	);
}

export async function handleTeamEnvCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	taskListId: string | null;
	getTeamsExtensionEntryPath: () => string | null;
	shellQuote: (v: string) => string;
}): Promise<void> {
	const { ctx, rest, taskListId, getTeamsExtensionEntryPath, shellQuote } = opts;

	const nameRaw = rest[0];
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team env <name>", "error");
		return;
	}

	const name = sanitizeName(nameRaw);
	const teamId = ctx.sessionManager.getSessionId();
	const effectiveTlId = taskListId ?? teamId;
	const leadName = "team-lead";
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
