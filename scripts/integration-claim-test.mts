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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ensureTeamConfig } from "../extensions/teams/team-config.js";
import { getTeamDir } from "../extensions/teams/paths.js";
import { createTask, listTasks, type TeamTask } from "../extensions/teams/task-store.js";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

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

async function terminateAll(children: ChildProcess[]): Promise<void> {
	for (const c of children) {
		try {
			c.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

	// Give them a moment to flush + exit.
	const deadline = Date.now() + 10_000;
	for (const c of children) {
		while (c.exitCode === null && Date.now() < deadline) {
			await sleep(100);
		}
		if (c.exitCode === null) {
			try {
				c.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	}
}

function spawnWorker(opts: {
	repoRoot: string;
	entryPath: string;
	sessionsDir: string;
	teamId: string;
	agentName: string;
	logDir: string;
}): ChildProcess {
	const { repoRoot, entryPath, sessionsDir, teamId, agentName, logDir } = opts;

	fs.mkdirSync(logDir, { recursive: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	const sessionFile = path.join(sessionsDir, `${agentName}.jsonl`);
	fs.closeSync(fs.openSync(sessionFile, "a"));

	const logPath = path.join(logDir, `${agentName}.log`);
	const out = fs.openSync(logPath, "a");
	const err = fs.openSync(logPath, "a");

	const args = [
		"--mode",
		"rpc",
		"--session",
		sessionFile,
		"--session-dir",
		sessionsDir,
		"--no-extensions",
		"-e",
		entryPath,
		"--append-system-prompt",
		["You are a teammate in an automated integration test.",
			"Keep replies extremely short.",
			"If you are assigned or auto-claim a task that says 'Reply with: okX', respond with exactly 'okX' and nothing else.",
		].join(" "),
	];

	return spawn("pi", args, {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_TEAMS_WORKER: "1",
			PI_TEAMS_TEAM_ID: teamId,
			PI_TEAMS_TASK_LIST_ID: teamId,
			PI_TEAMS_AGENT_NAME: agentName,
			PI_TEAMS_LEAD_NAME: "team-lead",
			PI_TEAMS_AUTO_CLAIM: "1",
			PI_TEAMS_PLAN_REQUIRED: "0",
		},
		stdio: ["ignore", out, err],
	});
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

console.log(`TeamId: ${teamId}`);
console.log(`TeamDir: ${teamDir}`);
console.log(`Spawning ${agents} worker(s), creating ${tasks} task(s)`);

await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "team-lead" });

// Create unowned tasks so at least one must be auto-claimed.
for (let i = 1; i <= tasks; i += 1) {
	await createTask(teamDir, teamId, {
		subject: `T${i}: reply ok${i}`,
		description: `Reply with: ok${i}`,
	});
}

const children: ChildProcess[] = [];
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
		children.push(
			spawnWorker({
				repoRoot,
				entryPath,
				sessionsDir,
				teamId,
				agentName: `agent${i}`,
				logDir: logsDir,
			}),
		);
	}

	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline) {
		const ts = await listTasks(teamDir, teamId);
		const done = ts.filter((t) => t.status === "completed").length;
		const inProgress = ts.filter((t) => t.status === "in_progress").length;
		const pending = ts.filter((t) => t.status === "pending").length;
		console.log(`tasks: completed=${done} in_progress=${inProgress} pending=${pending}`);
		if (allCompleted(ts)) {
			console.log("PASS: all tasks completed");
			const owners = ts.map((t) => `${t.id}:${t.owner ?? "-"}`);
			console.log(`owners: ${owners.join(" ")}`);
			process.exitCode = 0;
			break;
		}
		await sleep(1000);
	}

	if (process.exitCode !== 0) {
		console.error(`FAIL: timeout after ${timeoutSec}s (inspect logs under ${logsDir})`);
		process.exitCode = 1;
	}
} finally {
	await cleanup();
}
