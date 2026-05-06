/**
 * Integration test: spawn N real Pi worker processes (PI_TEAMS_WORKER=1) and
 * verify that unassigned tasks are auto-claimed + completed.
 *
 * This is intentionally "dumb": tasks are trivial and should complete quickly.
 * It exists to validate the end-to-end loop (task-store -> claim -> agent_end -> completeTask).
 *
 * Usage:
 *   npx tsx scripts/integration-claim-test.mts
 *   npx tsx scripts/integration-claim-test.mts --agents 2 --tasks 3 --timeoutSec 90
 *
 * On failure, the test prints a task/worker summary and worker log tails so
 * child spawn/exit/provider failures are actionable without hunting for files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { ensureTeamConfig } from "../extensions/teams/team-config.js";
import { getTeamDir } from "../extensions/teams/paths.js";
import { createTask, listTasks, type TeamTask } from "../extensions/teams/task-store.js";

import { sleep, spawnTeamsWorkerRpc, terminateAll } from "./lib/pi-workers.js";

function parseArgs(argv: readonly string[]): { agents: number; tasks: number; timeoutSec: number } {
	let agents = 2;
	let tasks = 3;
	let timeoutSec = 60;

	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--agents") {
			const v = argv[i + 1];
			if (v) agents = Number.parseInt(v, 10);
			i += 1;
			continue;
		}
		if (a === "--tasks") {
			const v = argv[i + 1];
			if (v) tasks = Number.parseInt(v, 10);
			i += 1;
			continue;
		}
		if (a === "--timeoutSec") {
			const v = argv[i + 1];
			if (v) timeoutSec = Number.parseInt(v, 10);
			i += 1;
			continue;
		}
	}

	if (!Number.isFinite(agents) || agents < 1) agents = 2;
	if (!Number.isFinite(tasks) || tasks < 1) tasks = 3;
	if (!Number.isFinite(timeoutSec) || timeoutSec < 10) timeoutSec = 60;

	return { agents, tasks, timeoutSec };
}

function allCompleted(ts: TeamTask[]): boolean {
	return ts.length > 0 && ts.every((t) => t.status === "completed");
}

interface WorkerState {
	name: string;
	child: ChildProcess;
	logPath: string;
	spawned: boolean;
	error?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	exitedAt?: string;
}

function readLogTail(logPath: string, maxLines = 80, maxBytes = 64 * 1024): string {
	try {
		const stat = fs.statSync(logPath);
		const start = Math.max(0, stat.size - maxBytes);
		const fd = fs.openSync(logPath, "r");
		try {
			const buffer = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			const lines = buffer.toString("utf8").split(/\r?\n/);
			return lines.slice(-maxLines).join("\n").trimEnd();
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		return `<unable to read log tail: ${err instanceof Error ? err.message : String(err)}>`;
	}
}

function formatTaskSummary(ts: readonly TeamTask[]): string {
	if (ts.length === 0) return "  <no tasks found>";
	return ts
		.map((t) => `  #${t.id} status=${t.status} owner=${t.owner ?? "-"} updated=${t.updatedAt} subject=${t.subject}`)
		.join("\n");
}

function formatWorkerSummary(workers: readonly WorkerState[]): string {
	return workers
		.map((w) => {
			const exit = w.exitedAt
				? ` exitedAt=${w.exitedAt} code=${w.exitCode ?? "null"} signal=${w.signal ?? "null"}`
				: " running";
			const error = w.error ? ` error=${w.error}` : "";
			return `  ${w.name} pid=${w.child.pid ?? "-"} spawned=${w.spawned}${exit}${error} log=${w.logPath}`;
		})
		.join("\n");
}

async function buildFailureSummary(args: {
	reason: string;
	teamDir: string;
	logsDir: string;
	workers: readonly WorkerState[];
	timeoutSec: number;
}): Promise<string> {
	let taskSummary: string;
	try {
		taskSummary = formatTaskSummary(await listTasks(args.teamDir, teamId));
	} catch (err) {
		taskSummary = `  <unable to read tasks: ${err instanceof Error ? err.message : String(err)}>`;
	}

	const logSections = args.workers
		.map((w) => [`--- ${w.name} log tail (${w.logPath}) ---`, readLogTail(w.logPath), ""].join("\n"))
		.join("\n");

	return [
		`FAIL: ${args.reason}`,
		`TeamId: ${teamId}`,
		`TeamDir: ${args.teamDir}`,
		`LogsDir: ${args.logsDir}`,
		`TimeoutSec: ${args.timeoutSec}`,
		"Tasks:",
		taskSummary,
		"Workers:",
		formatWorkerSummary(args.workers),
		"Actionable next steps:",
		"  - Inspect the worker log tails below or full logs under LogsDir.",
		"  - If workers did not spawn, verify the `pi` CLI is on PATH and runnable from this repo.",
		"  - If workers spawned but made no progress, check Pi provider/auth/model errors in the logs.",
		"  - For slow providers, rerun with a larger --timeoutSec value.",
		logSections,
	].join("\n");
}

const { agents, tasks, timeoutSec } = parseArgs(process.argv.slice(2));

if (agents < 2 || tasks < 3) {
	console.error("This test expects at least --agents 2 and --tasks 3.");
	process.exit(2);
}

const teamId = randomUUID();
const teamDir = getTeamDir(teamId);
const sessionsDir = path.join(os.homedir(), ".pi", "agent", "teams", teamId, "sessions");
const logsDir = path.join(os.homedir(), ".pi", "agent", "teams", teamId, "logs");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");

const systemAppend = [
	"You are a teammate in an automated integration test.",
	"Keep replies extremely short.",
	"If you are assigned or auto-claim a task that says 'Reply with: okX', respond with exactly 'okX' and nothing else.",
].join(" ");

console.log(`TeamId: ${teamId}`);
console.log(`TeamDir: ${teamDir}`);
console.log(`Spawning ${agents} worker(s), creating ${tasks} task(s)`);

await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "team-lead", style: "normal" });

// Create unowned tasks so at least one must be auto-claimed.
for (let i = 1; i <= tasks; i += 1) {
	await createTask(teamDir, teamId, {
		subject: `T${i}: reply ok${i}`,
		description: `Reply with: ok${i}`,
	});
}

const children: ChildProcess[] = [];
const workers: WorkerState[] = [];
let cleaningUp = false;
const cleanup = async (): Promise<void> => {
	if (cleaningUp) return;
	cleaningUp = true;
	await terminateAll(children);
};

process.on("SIGINT", () => {
	void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
	void cleanup().finally(() => process.exit(143));
});

try {
	for (let i = 1; i <= agents; i += 1) {
		const name = `agent${i}`;
		const child = spawnTeamsWorkerRpc({
			cwd: repoRoot,
			entryPath,
			sessionsDir,
			teamId,
			taskListId: teamId,
			agentName: name,
			leadName: "team-lead",
			style: "normal",
			autoClaim: true,
			planRequired: false,
			systemAppend,
			logDir: logsDir,
		});
		children.push(child);

		const worker: WorkerState = {
			name,
			child,
			logPath: path.join(logsDir, `${name}.log`),
			spawned: false,
		};
		workers.push(worker);
		child.once("spawn", () => {
			worker.spawned = true;
			console.log(`worker ${name} spawned pid=${child.pid ?? "-"} log=${worker.logPath}`);
		});
		child.once("error", (err) => {
			worker.error = err.message;
		});
		child.once("exit", (code, signal) => {
			worker.exitCode = code;
			worker.signal = signal;
			worker.exitedAt = new Date().toISOString();
			if (!cleaningUp) {
				console.error(`worker ${name} exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`);
			}
		});
	}

	let failureReason: string | null = null;
	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline && failureReason === null) {
		const ts = await listTasks(teamDir, teamId);
		const done = ts.filter((t) => t.status === "completed").length;
		const inProgress = ts.filter((t) => t.status === "in_progress").length;
		const pending = ts.filter((t) => t.status === "pending").length;
		const exited = workers.filter((w) => w.exitedAt || w.error);
		console.log(
			`tasks: completed=${done} in_progress=${inProgress} pending=${pending} workers_exited=${exited.length}/${workers.length}`,
		);
		if (allCompleted(ts)) {
			console.log("PASS: all tasks completed");
			const owners = ts.map((t) => `${t.id}:${t.owner ?? "-"}`);
			console.log(`owners: ${owners.join(" ")}`);
			process.exitCode = 0;
			break;
		}
		if (exited.length > 0) {
			failureReason = `worker process exited before all tasks completed (${exited
				.map((w) => `${w.name}: code=${w.exitCode ?? "null"} signal=${w.signal ?? "null"}${w.error ? ` error=${w.error}` : ""}`)
				.join(", ")})`;
			break;
		}
		await sleep(1000);
	}

	if (process.exitCode !== 0) {
		const reason = failureReason ?? `timeout after ${timeoutSec}s before all tasks completed`;
		console.error(await buildFailureSummary({ reason, teamDir, logsDir, workers, timeoutSec }));
		process.exitCode = 1;
	}
} finally {
	await cleanup();
}
