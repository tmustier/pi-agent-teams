import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxContext {
	sessionName: string;
	windowId: string;
	leaderPaneId: string;
}

interface TmuxPaneInfo {
	paneId: string;
	width: number;
	height: number;
}

async function tmux(args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`tmux ${args.join(" ")} failed: ${msg}`);
	}
}

export function isTmuxSpawnMode(env: NodeJS.ProcessEnv = process.env): boolean {
	const mode = (env.PI_TEAMS_SPAWN_MODE ?? env.PI_TEAMS_SPAWN_BACKEND ?? "").trim().toLowerCase();
	return mode === "tmux" || mode === "pane" || mode === "panes";
}

export async function getTmuxContext(env: NodeJS.ProcessEnv = process.env): Promise<TmuxContext | null> {
	if (!env.TMUX && !env.TMUX_PANE && !env.PI_TEAMS_TMUX_LEADER_PANE) return null;

	let leaderPaneId = env.PI_TEAMS_TMUX_LEADER_PANE || env.TMUX_PANE || "";
	if (!leaderPaneId) {
		leaderPaneId = await tmux(["display-message", "-p", "#{pane_id}"]);
	}
	if (!leaderPaneId) return null;

	const line = await tmux(["display-message", "-p", "-t", leaderPaneId, "#{session_name}\t#{window_id}\t#{pane_id}"]);
	const [sessionName, windowId, paneId] = line.split("\t");
	if (!sessionName || !windowId || !paneId) return null;
	return { sessionName, windowId, leaderPaneId: paneId };
}

async function listPanes(windowId: string): Promise<TmuxPaneInfo[]> {
	const out = await tmux(["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_width}\t#{pane_height}"]);
	if (!out.trim()) return [];
	return out
		.split(/\r?\n/)
		.map((line) => {
			const [paneId, widthRaw, heightRaw] = line.split("\t");
			const width = Number.parseInt(widthRaw ?? "", 10);
			const height = Number.parseInt(heightRaw ?? "", 10);
			if (!paneId || !Number.isFinite(width) || !Number.isFinite(height)) return null;
			return { paneId, width, height } satisfies TmuxPaneInfo;
		})
		.filter((p): p is TmuxPaneInfo => p !== null);
}

function chooseLargestPane(panes: readonly TmuxPaneInfo[]): TmuxPaneInfo | null {
	let best: TmuxPaneInfo | null = null;
	let bestArea = -1;
	for (const pane of panes) {
		const area = pane.width * pane.height;
		if (area > bestArea) {
			best = pane;
			bestArea = area;
		}
	}
	return best;
}

function splitFlagForPane(pane: TmuxPaneInfo | null, targetIsLeader: boolean): "-h" | "-v" {
	if (targetIsLeader || !pane) return "-h";
	return pane.width >= pane.height * 2 ? "-h" : "-v";
}

async function resizeLeaderPane(ctx: TmuxContext, env: NodeJS.ProcessEnv): Promise<void> {
	const pctRaw = env.PI_TEAMS_TMUX_LEADER_WIDTH_PCT ?? "40";
	const pct = Math.max(20, Math.min(80, Number.parseInt(pctRaw, 10) || 40));
	try {
		const widthRaw = await tmux(["display-message", "-p", "-t", ctx.windowId, "#{window_width}"]);
		const width = Number.parseInt(widthRaw, 10);
		if (!Number.isFinite(width) || width <= 0) return;
		const leaderWidth = Math.max(30, Math.floor((width * pct) / 100));
		await tmux(["resize-pane", "-t", ctx.leaderPaneId, "-x", String(leaderWidth)]);
	} catch {
		// Best-effort only: small terminal sizes can reject resize requests.
	}
}

export async function spawnWorkerPane(opts: {
	ctx: TmuxContext;
	command: string;
	cwd: string;
	workerName: string;
	knownWorkerPaneIds: readonly string[];
	env?: NodeJS.ProcessEnv;
}): Promise<string> {
	const env = opts.env ?? process.env;
	const panes = await listPanes(opts.ctx.windowId);
	const paneById = new Map(panes.map((p) => [p.paneId, p]));
	const liveWorkerPanes = opts.knownWorkerPaneIds
		.map((id) => paneById.get(id))
		.filter((p): p is TmuxPaneInfo => p !== undefined);

	const targetPane = liveWorkerPanes.length > 0 ? chooseLargestPane(liveWorkerPanes) : paneById.get(opts.ctx.leaderPaneId) ?? null;
	const targetPaneId = targetPane?.paneId ?? opts.ctx.leaderPaneId;
	const targetIsLeader = targetPaneId === opts.ctx.leaderPaneId;
	const splitFlag = splitFlagForPane(targetPane, targetIsLeader);

	const paneId = await tmux([
		"split-window",
		"-d",
		splitFlag,
		"-t",
		targetPaneId,
		"-P",
		"-F",
		"#{pane_id}",
		"-c",
		opts.cwd,
		opts.command,
	]);

	try {
		await tmux(["select-pane", "-t", paneId, "-T", opts.workerName]);
	} catch {
		// Pane titles are cosmetic.
	}

	await resizeLeaderPane(opts.ctx, env);
	try {
		await tmux(["select-pane", "-t", opts.ctx.leaderPaneId]);
	} catch {
		// Best-effort focus restore.
	}

	return paneId;
}

export async function killPane(paneId: string): Promise<void> {
	await tmux(["kill-pane", "-t", paneId]);
}
