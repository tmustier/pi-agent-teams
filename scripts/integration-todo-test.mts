/**
 * Integration test: spawn 3 real Pi worker processes and create 15 dependent tasks
 * that collaboratively build a minimal (vanilla JS) todo app in a dedicated team
 * artifacts workspace.
 *
 * Requirements covered:
 * - Uses task-store createTask + addTaskDependency; relies on worker auto-claim.
 * - 3 agents, 15 tasks, realistic dependency order.
 * - Workspace is under ~/.pi/agent/teams/<teamId>/artifacts/todo-app (teamDir/artifacts/todo-app).
 * - Periodically prints status counts; prints per-task summary on completion.
 * - After completion, tails the session .jsonl files for each agent.
 *
 * Usage:
 *   npx tsx scripts/integration-todo-test.mts
 *   npx tsx scripts/integration-todo-test.mts --timeoutSec 900
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ensureTeamConfig } from "../extensions/teams/team-config.js";
import { getTeamDir } from "../extensions/teams/paths.js";
import {
	addTaskDependency,
	isTaskBlocked,
	listTasks,
	createTask,
	type TeamTask,
} from "../extensions/teams/task-store.js";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: readonly string[]): { timeoutSec: number; pollMs: number } {
	let timeoutSec = 15 * 60;
	let pollMs = 1500;

	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--timeoutSec") {
			const v = argv[i + 1];
			if (v) timeoutSec = Number.parseInt(v, 10);
			i += 1;
			continue;
		}
		if (a === "--pollMs") {
			const v = argv[i + 1];
			if (v) pollMs = Number.parseInt(v, 10);
			i += 1;
			continue;
		}
	}

	if (!Number.isFinite(timeoutSec) || timeoutSec < 60) timeoutSec = 15 * 60;
	if (!Number.isFinite(pollMs) || pollMs < 250) pollMs = 1500;
	return { timeoutSec, pollMs };
}

async function terminateAll(children: ChildProcess[]): Promise<void> {
	for (const c of children) {
		try {
			c.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

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
	cwd: string;
	repoRoot: string;
	entryPath: string;
	sessionsDir: string;
	teamId: string;
	agentName: string;
	logDir: string;
}): ChildProcess {
	const { cwd, repoRoot, entryPath, sessionsDir, teamId, agentName, logDir } = opts;

	fs.mkdirSync(logDir, { recursive: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	const sessionFile = path.join(sessionsDir, `${agentName}.jsonl`);
	fs.closeSync(fs.openSync(sessionFile, "a"));

	const logPath = path.join(logDir, `${agentName}.log`);
	const out = fs.openSync(logPath, "a");
	const err = fs.openSync(logPath, "a");

	const systemAppend = [
		"You are a teammate in an automated integration test.",
		"Work ONLY inside the current working directory.",
		"Keep replies short (<= 8 lines).",
		"Always end with: ACCEPTED: <one-line acceptance confirmation>.",
	].join(" ");

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
		systemAppend,
	];

	return spawn("pi", args, {
		cwd,
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

function allCompleted(tasks: TeamTask[]): boolean {
	return tasks.length === 15 && tasks.every((t) => t.status === "completed");
}

type TaskKey =
	| "scaffold"
	| "html"
	| "css"
	| "model"
	| "storage"
	| "main_add"
	| "main_toggle_remove"
	| "filters"
	| "clear_completed"
	| "persistence"
	| "test_model"
	| "test_storage"
	| "verify_script"
	| "readme"
	| "qa";

type PlannedTask = {
	key: TaskKey;
	subject: string;
	description: string;
	dependsOn: TaskKey[];
};

function plannedTasks(): PlannedTask[] {
	return [
		{
			key: "scaffold",
			subject: "Todo app: scaffold workspace (dirs + package.json)",
			description: [
				"Create a minimal vanilla-JS todo app workspace.",
				"- Create directories: src/, test/, scripts/",
				"- Create .gitignore (ignore node_modules, .DS_Store)",
				"- Create package.json (type: module, private: true) with scripts:",
				"  - test: node --test",
				"  - verify: node scripts/verify.mjs",
				"  - start: python3 -m http.server 5173",
				"Acceptance: ls shows src/ test/ scripts/ and package.json has those scripts.",
			].join("\n"),
			dependsOn: [],
		},
		{
			key: "html",
			subject: "Todo app: add index.html skeleton", 
			description: [
				"Create index.html in repo root (workspace root).",
				"Requirements:",
				"- Link styles.css",
				"- Load <script type=\"module\" src=\"./src/main.js\"></script>",
				"- Layout includes: h1, input#new-todo, button#add-todo, ul#todo-list",
				"- Include filter buttons with data-filter=all|active|completed inside #filters",
				"- Include button#clear-completed",
				"Acceptance: index.html contains the required ids and module script tag.",
			].join("\n"),
			dependsOn: ["scaffold"],
		},
		{
			key: "css",
			subject: "Todo app: add styles.css", 
			description: [
				"Create styles.css with basic readable styling (centered container, list rows, buttons).",
				"Keep it minimal (no frameworks).",
				"Acceptance: styles.css exists and includes rules for #app and #todo-list li.",
			].join("\n"),
			dependsOn: ["scaffold"],
		},
		{
			key: "model",
			subject: "Todo app: implement src/model.js (pure state helpers)",
			description: [
				"Create src/model.js exporting pure functions (no DOM, no localStorage).",
				"State shape suggestion: { todos: Array<{id:string,text:string,completed:boolean}>, filter: 'all'|'active'|'completed' }",
				"Export these named functions:",
				"- createInitialState()",
				"- addTodo(state, text)",
				"- toggleTodo(state, id)",
				"- removeTodo(state, id)",
				"- clearCompleted(state)",
				"- setFilter(state, filter)",
				"- getVisibleTodos(state)",
				"Implementation notes: do not mutate the input state; return new objects.",
				"Acceptance: src/model.js exists and exports all functions listed above.",
			].join("\n"),
			dependsOn: ["scaffold"],
		},
		{
			key: "storage",
			subject: "Todo app: implement src/storage.js (localStorage + serialization)",
			description: [
				"Create src/storage.js.",
				"Export:",
				"- const STORAGE_KEY = 'todo-app-state-v1'",
				"- serializeState(state) => string",
				"- deserializeState(raw) => state|null (return null on invalid)",
				"- loadState() => state|null (returns null if localStorage unavailable)",
				"- saveState(state) => void (no-op if localStorage unavailable)",
				"Acceptance: src/storage.js exists and loadState/saveState do not throw in Node.",
			].join("\n"),
			dependsOn: ["scaffold"],
		},
		{
			key: "main_add",
			subject: "Todo app: implement src/main.js (render + add)",
			description: [
				"Create src/main.js to wire up the UI.",
				"- Import createInitialState/addTodo/getVisibleTodos from src/model.js",
				"- On load, create state and render ul#todo-list",
				"- Support adding todos via button#add-todo and Enter in input#new-todo",
				"- Basic render: each todo is an <li> with its text",
				"Acceptance: src/main.js exists, imports model.js, and add works via DOM event listeners.",
			].join("\n"),
			dependsOn: ["html", "model"],
		},
		{
			key: "main_toggle_remove",
			subject: "Todo app: main.js toggle + remove controls", 
			description: [
				"Update src/main.js UI to support:",
				"- toggle completed via checkbox per item (uses toggleTodo)",
				"- remove via a delete button per item (uses removeTodo)",
				"- visually indicate completed (e.g. line-through)",
				"Acceptance: rendered list items include a checkbox and delete button and handlers update state.",
			].join("\n"),
			dependsOn: ["main_add"],
		},
		{
			key: "filters",
			subject: "Todo app: wire filter buttons (all/active/completed)",
			description: [
				"Update src/main.js to wire #filters buttons (data-filter=all|active|completed).",
				"- Use setFilter/getVisibleTodos from model.js",
				"- Add an 'active' CSS class on the selected filter button",
				"Acceptance: clicking filter buttons changes rendered list length appropriately.",
			].join("\n"),
			dependsOn: ["main_toggle_remove"],
		},
		{
			key: "clear_completed",
			subject: "Todo app: implement clear completed", 
			description: [
				"Update model.js and main.js to support clearing completed todos.",
				"- Use clearCompleted(state)",
				"- Wire button#clear-completed",
				"Acceptance: clicking clear completed removes completed todos from state + UI.",
			].join("\n"),
			dependsOn: ["filters"],
		},
		{
			key: "persistence",
			subject: "Todo app: persistence (load on start, save on changes)",
			description: [
				"Update src/main.js to persist state.",
				"- Import loadState/saveState from storage.js",
				"- On startup, initialize state from loadState() if non-null",
				"- After any state change, call saveState(state) (a small debounce is ok)",
				"Acceptance: main.js imports storage.js and calls saveState after add/toggle/remove/filter/clear.",
			].join("\n"),
			dependsOn: ["clear_completed", "storage"],
		},
		{
			key: "test_model",
			subject: "Todo app: add node:test unit tests for model.js",
			description: [
				"Create test/model.test.js using node:test + node:assert/strict.",
				"Cover: addTodo, toggleTodo, removeTodo, clearCompleted, filters (getVisibleTodos).",
				"Acceptance: `node --test test/model.test.js` passes.",
			].join("\n"),
			dependsOn: ["model", "scaffold"],
		},
		{
			key: "test_storage",
			subject: "Todo app: add tests for storage serialization", 
			description: [
				"Create test/storage.test.js testing serializeState/deserializeState.",
				"- roundtrip returns equivalent state",
				"- invalid input returns null",
				"Acceptance: `node --test test/storage.test.js` passes.",
			].join("\n"),
			dependsOn: ["storage", "scaffold"],
		},
		{
			key: "verify_script",
			subject: "Todo app: scripts/verify.mjs (fast local verification)",
			description: [
				"Create scripts/verify.mjs that:",
				"- checks required files exist (index.html, styles.css, src/main.js, src/model.js, src/storage.js)",
				"- imports model.js and does a tiny sanity check (add -> toggle)",
				"- runs `node --test` as a subprocess (or via spawnSync) and fails if tests fail",
				"- prints exactly: verify: ok",
				"Acceptance: `node scripts/verify.mjs` prints 'verify: ok' and exits 0.",
			].join("\n"),
			dependsOn: ["test_model", "test_storage", "persistence", "html", "css"],
		},
		{
			key: "readme",
			subject: "Todo app: write README.md", 
			description: [
				"Create README.md describing:",
				"- what the app does",
				"- how to run locally (python http.server)",
				"- how to run tests + verify",
				"Acceptance: README.md exists and mentions `npm test` and `npm run verify`.",
			].join("\n"),
			dependsOn: ["verify_script"],
		},
		{
			key: "qa",
			subject: "Todo app: final QA run (tests + verify)",
			description: [
				"Run the final checks and fix any issues:",
				"- npm test",
				"- npm run verify",
				"If anything fails, fix files until both pass.",
				"Acceptance: paste the final two command outputs (or at least their last lines) showing success.",
			].join("\n"),
			dependsOn: ["readme"],
		},
	];
}

function tailLines(raw: string, n: number): string[] {
	const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
	return lines.slice(Math.max(0, lines.length - n));
}

function tailFile(filePath: string, n: number): string {
	try {
		const st = fs.statSync(filePath);
		if (!st.isFile()) return "";
		// Read at most last 256 KiB.
		const maxBytes = 256 * 1024;
		const start = Math.max(0, st.size - maxBytes);
		const fd = fs.openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(st.size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			return tailLines(buf.toString("utf8"), n).join("\n");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

function printTaskSummary(tasks: TeamTask[]): void {
	const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	console.log("\nPer-task summary (id owner subject):");
	for (const t of sorted) {
		console.log(`- #${t.id} ${(t.owner ?? "-").padEnd(7)} ${t.subject}`);
	}
}

function runWorkspaceVerify(workspaceDir: string): { ok: boolean; output: string } {
	const res = spawnSync("npm", ["run", "-s", "verify"], {
		cwd: workspaceDir,
		encoding: "utf8",
		timeout: 120_000,
	});
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
	return { ok: res.status === 0, output: out };
}

const { timeoutSec, pollMs } = parseArgs(process.argv.slice(2));

const teamId = randomUUID();
const teamDir = getTeamDir(teamId);
const workspaceDir = path.join(teamDir, "artifacts", "todo-app");
const sessionsDir = path.join(teamDir, "sessions");
const logsDir = path.join(teamDir, "logs");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");

console.log(`TeamId: ${teamId}`);
console.log(`TeamDir: ${teamDir}`);
console.log(`Workspace: ${workspaceDir}`);
console.log("Spawning 3 workers, creating 15 tasks (todo app)");

fs.mkdirSync(workspaceDir, { recursive: true });

await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "team-lead" });

// Create tasks first (unowned) then add dependencies.
const plan = plannedTasks();
if (plan.length !== 15) {
	throw new Error(`Expected 15 planned tasks, got ${plan.length}`);
}

const created = new Map<TaskKey, TeamTask>();
for (const p of plan) {
	const t = await createTask(teamDir, teamId, { subject: p.subject, description: p.description });
	created.set(p.key, t);
}

for (const p of plan) {
	const task = created.get(p.key);
	if (!task) throw new Error(`Missing task: ${p.key}`);
	for (const depKey of p.dependsOn) {
		const dep = created.get(depKey);
		if (!dep) throw new Error(`Missing dependency: ${p.key} -> ${depKey}`);
		const res = await addTaskDependency(teamDir, teamId, task.id, dep.id);
		if (!res.ok) throw new Error(`addTaskDependency failed: ${res.error}`);
	}
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
	for (let i = 1; i <= 3; i += 1) {
		children.push(
			spawnWorker({
				cwd: workspaceDir,
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
		const completed = ts.filter((t) => t.status === "completed").length;
		const inProgress = ts.filter((t) => t.status === "in_progress").length;
		const pending = ts.filter((t) => t.status === "pending").length;

		let blocked = 0;
		for (const t of ts) {
			if (t.status !== "pending") continue;
			if (await isTaskBlocked(teamDir, teamId, t)) blocked += 1;
		}

		console.log(
			`tasks: completed=${completed} in_progress=${inProgress} pending=${pending} blocked=${blocked}`,
		);

		if (allCompleted(ts)) {
			console.log("PASS: all tasks completed");
			printTaskSummary(ts);

			const verify = runWorkspaceVerify(workspaceDir);
			if (!verify.ok) {
				console.error("FAIL: workspace verification failed (npm run verify)");
				console.error(verify.output);
				process.exitCode = 1;
			} else {
				console.log("Workspace verification: ok");
				process.exitCode = 0;
			}
			break;
		}

		await sleep(pollMs);
	}

	if (process.exitCode !== 0 && process.exitCode !== 1) {
		console.error(`FAIL: timeout after ${timeoutSec}s (inspect logs under ${logsDir})`);
		const ts = await listTasks(teamDir, teamId);
		printTaskSummary(ts);
		process.exitCode = 1;
	}
} finally {
	await cleanup();

	// Transcript inspection (tail sessions)
	console.log("\nSession tails (last ~30 lines each):");
	for (let i = 1; i <= 3; i += 1) {
		const agentName = `agent${i}`;
		const sessionFile = path.join(sessionsDir, `${agentName}.jsonl`);
		console.log(`\n--- ${agentName}: ${sessionFile} ---`);
		const tail = tailFile(sessionFile, 30);
		console.log(tail || "(no session output)");
	}

	console.log(`\nWorkspace remains at: ${workspaceDir}`);
}
