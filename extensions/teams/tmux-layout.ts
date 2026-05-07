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

export type TmuxExecutor = (args: readonly string[]) => Promise<string>;

const spawnedWorkerPaneIdsByWindow = new Map<string, Set<string>>();
let spawnWorkerPaneQueue: Promise<void> = Promise.resolve();

async function defaultTmux(args: readonly string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("tmux", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`tmux ${args.join(" ")} failed: ${msg}`);
	}
}

async function tmux(args: readonly string[], exec: TmuxExecutor = defaultTmux): Promise<string> {
	return (await exec(args)).trim();
}

async function runSpawnWorkerPaneExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const previous = spawnWorkerPaneQueue;
	let release: () => void = () => undefined;
	spawnWorkerPaneQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await fn();
	} finally {
		release();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
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

async function listPanes(windowId: string, exec?: TmuxExecutor): Promise<TmuxPaneInfo[]> {
	const out = await tmux(["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_width}\t#{pane_height}"], exec);
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

function splitFlagForTarget(targetIsLeader: boolean): "-h" | "-v" {
	// Keep the leader as one large pane on the left. The first worker is created
	// by splitting the leader left/right; all later workers split the worker
	// column top/bottom so the right side stacks horizontally-divided panes.
	return targetIsLeader ? "-h" : "-v";
}

async function resizeLeaderPane(ctx: TmuxContext, env: NodeJS.ProcessEnv, exec?: TmuxExecutor): Promise<void> {
	const pctRaw = env.PI_TEAMS_TMUX_LEADER_WIDTH_PCT ?? "40";
	const pct = Math.max(20, Math.min(80, Number.parseInt(pctRaw, 10) || 40));
	try {
		const widthRaw = await tmux(["display-message", "-p", "-t", ctx.windowId, "#{window_width}"], exec);
		const width = Number.parseInt(widthRaw, 10);
		if (!Number.isFinite(width) || width <= 0) return;
		const leaderWidth = Math.max(30, Math.floor((width * pct) / 100));
		await tmux(["resize-pane", "-t", ctx.leaderPaneId, "-x", String(leaderWidth)], exec);
	} catch {
		// Best-effort only: small terminal sizes can reject resize requests.
	}
}

async function verifyPaneCreated(windowId: string, paneId: string, env: NodeJS.ProcessEnv, exec?: TmuxExecutor): Promise<void> {
	const timeoutMs = envInt(env, "PI_TEAMS_TMUX_SPLIT_VERIFY_TIMEOUT_MS", 500, 0, 30_000);
	const pollMs = envInt(env, "PI_TEAMS_TMUX_SPLIT_VERIFY_POLL_MS", 25, 1, 1_000);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const panes = await listPanes(windowId, exec);
		if (panes.some((pane) => pane.paneId === paneId)) return;
		if (Date.now() >= deadline) {
			throw new Error(`tmux split-window reported pane ${paneId}, but it was not visible in window ${windowId}`);
		}
		await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}

export async function spawnWorkerPane(opts: {
	ctx: TmuxContext;
	command: string;
	cwd: string;
	workerName: string;
	knownWorkerPaneIds: readonly string[];
	env?: NodeJS.ProcessEnv;
	tmuxExecutor?: TmuxExecutor;
}): Promise<string> {
	return runSpawnWorkerPaneExclusive(async () => {
		const env = opts.env ?? process.env;
		const exec = opts.tmuxExecutor;
		const panes = await listPanes(opts.ctx.windowId, exec);
		const paneById = new Map(panes.map((p) => [p.paneId, p]));
		const spawnedWorkerPaneIds = spawnedWorkerPaneIdsByWindow.get(opts.ctx.windowId) ?? new Set<string>();
		const candidateWorkerPaneIds = new Set([...opts.knownWorkerPaneIds, ...spawnedWorkerPaneIds]);
		const liveWorkerPanes = [...candidateWorkerPaneIds]
			.map((id) => paneById.get(id))
			.filter((p): p is TmuxPaneInfo => p !== undefined);

		const targetPane = liveWorkerPanes.length > 0 ? chooseLargestPane(liveWorkerPanes) : paneById.get(opts.ctx.leaderPaneId) ?? null;
		const targetPaneId = targetPane?.paneId ?? opts.ctx.leaderPaneId;
		const targetIsLeader = targetPaneId === opts.ctx.leaderPaneId;
		const splitFlag = splitFlagForTarget(targetIsLeader);

		const paneId = await tmux(
			[
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
			],
			exec,
		);

		const verifyDelayMs = envInt(env, "PI_TEAMS_TMUX_SPLIT_VERIFY_DELAY_MS", 25, 0, 5_000);
		if (verifyDelayMs > 0) await sleep(verifyDelayMs);
		await verifyPaneCreated(opts.ctx.windowId, paneId, env, exec);
		if (!spawnedWorkerPaneIdsByWindow.has(opts.ctx.windowId)) {
			spawnedWorkerPaneIdsByWindow.set(opts.ctx.windowId, spawnedWorkerPaneIds);
		}
		spawnedWorkerPaneIds.add(paneId);

		try {
			await tmux(["select-pane", "-t", paneId, "-T", opts.workerName], exec);
		} catch {
			// Pane titles are cosmetic.
		}

		await resizeLeaderPane(opts.ctx, env, exec);
		try {
			await tmux(["select-pane", "-t", opts.ctx.leaderPaneId], exec);
		} catch {
			// Best-effort focus restore.
		}

		return paneId;
	});
}

export async function killPane(paneId: string): Promise<void> {
	await tmux(["kill-pane", "-t", paneId]);
}
