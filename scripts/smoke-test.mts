/**
 * Smoke test for pi-agent-teams extension primitives.
 *
 * Tests: fs-lock, mailbox, task-store, team-config, protocol parsers, names.
 * Does NOT require a running Pi session — exercises the library code directly.
 *
 * Usage:  npx tsx scripts/smoke-test.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We import from .ts source (tsx handles it)
import { withLock } from "../extensions/teams/fs-lock.js";
import { writeToMailbox, popUnreadMessages, getInboxPath } from "../extensions/teams/mailbox.js";
import {
	createTask,
	listTasks,
	getTask,
	updateTask,
	completeTask,
	clearTasks,
	startAssignedTask,
	claimNextAvailableTask,
	unassignTasksForAgent,
	formatTaskLine,
	addTaskDependency,
	removeTaskDependency,
	isTaskBlocked,
} from "../extensions/teams/task-store.js";
import { ensureTeamConfig, loadTeamConfig, upsertMember, setMemberStatus } from "../extensions/teams/team-config.js";
import { sanitizeName } from "../extensions/teams/names.js";
import { getTeamsNamingRules, getTeamsStrings } from "../extensions/teams/teams-style.js";
import { runTeamsHook } from "../extensions/teams/hooks.js";
import { listDiscoveredTeams } from "../extensions/teams/team-discovery.js";
import { getTeamHelpText } from "../extensions/teams/leader-team-command.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isShutdownApproved,
	isShutdownRejected,
	isTaskAssignmentMessage,
	isShutdownRequestMessage,
	isSetSessionNameMessage,
	isPlanApprovalRequest,
	isPeerDmSent,
	isAbortRequestMessage,
	isPlanApprovedMessage,
	isPlanRejectedMessage,
} from "../extensions/teams/protocol.js";

// ── helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

function assertEq(actual: unknown, expected: unknown, label: string) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		console.error(`    actual:   ${JSON.stringify(actual)}`);
		console.error(`    expected: ${JSON.stringify(expected)}`);
	}
	assert(ok, label);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-smoke-"));
const teamDir = path.join(tmpRoot, "team-test");
const taskListId = "smoke-tl";

console.log(`\nSmoke test root: ${tmpRoot}\n`);

// ── 1. names ─────────────────────────────────────────────────────────
console.log("1. names.sanitizeName");
// sanitizeName replaces non-alnum/underscore/hyphen with hyphens, preserves case
assertEq(sanitizeName("Hello World!"), "Hello-World-", "non-alnum → hyphens");
assertEq(sanitizeName("agent_1"), "agent_1", "underscores kept");
assertEq(sanitizeName(""), "", "empty stays empty");
assertEq(sanitizeName("UPPER"), "UPPER", "case preserved");

// ── 2. fs-lock ───────────────────────────────────────────────────────
console.log("\n2. fs-lock.withLock");
{
	const lockFile = path.join(tmpRoot, "test.lock");
	const result = await withLock(lockFile, async () => 42, { label: "smoke" });
	assertEq(result, 42, "withLock returns fn result");
	assert(!fs.existsSync(lockFile), "lock file cleaned up after");
}

{
	// Stale lock is removed.
	const lockFile = path.join(tmpRoot, "stale.lock");
	fs.writeFileSync(lockFile, "stale");
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lockFile, old, old);

	const result = await withLock(lockFile, async () => "ok", { staleMs: 1, timeoutMs: 500 });
	assertEq(result, "ok", "withLock removes stale lock file");
	assert(!fs.existsSync(lockFile), "stale lock cleaned up after");
}

{
	// Contention: many concurrent callers should serialize without throwing.
	const lockFile = path.join(tmpRoot, "contended.lock");
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	let counter = 0;

	const runners = Array.from({ length: 20 }, () =>
		withLock(
			lockFile,
			async () => {
				counter += 1;
				await sleep(5);
				return counter;
			},
			{ timeoutMs: 5_000, pollMs: 2 },
		),
	);

	await Promise.all(runners);
	assertEq(counter, 20, "withLock serializes contended callers");
	assert(!fs.existsSync(lockFile), "contended lock cleaned up after");
}

// ── 3. mailbox ───────────────────────────────────────────────────────
console.log("\n3. mailbox");
{
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "hello agent1",
		timestamp: "2025-01-01T00:00:00Z",
	});
	const inboxPath = getInboxPath(teamDir, TEAM_MAILBOX_NS, "agent1");
	assert(fs.existsSync(inboxPath), "inbox file created");

	const raw: unknown = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
	assert(Array.isArray(raw), "inbox json is array");
	assertEq(Array.isArray(raw) ? raw.length : 0, 1, "one message in inbox");
	const first = Array.isArray(raw) ? raw.at(0) : undefined;
	assert(isRecord(first) && typeof first.read === "boolean", "message has boolean read");
	if (isRecord(first) && typeof first.read === "boolean") {
		assertEq(first.read, false, "message initially unread");
	}

	// pop
	const msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs.length, 1, "popUnreadMessages returns 1");
	const m0 = msgs.at(0);
	assert(m0 !== undefined, "pop returned first message");
	if (m0) assertEq(m0.text, "hello agent1", "message text correct");

	// re-pop should be empty
	const msgs2 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs2.length, 0, "second pop returns 0 (already read)");

	// multiple messages
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "msg2",
		timestamp: "2025-01-01T00:01:00Z",
	});
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "peer",
		text: "msg3",
		timestamp: "2025-01-01T00:02:00Z",
	});
	const msgs3 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs3.length, 2, "pop returns 2 new unread messages");
}

// ── 4. task-store ────────────────────────────────────────────────────
console.log("\n4. task-store");
{
	const t1 = await createTask(teamDir, taskListId, {
		subject: "Write tests",
		description: "Write unit tests for the extension",
		owner: "agent1",
	});
	assert(typeof t1.id === "string" && t1.id.length > 0, "task created with id");
	assertEq(t1.status, "pending", "new task is pending");
	assertEq(t1.owner, "agent1", "owner set");

	const t2 = await createTask(teamDir, taskListId, {
		subject: "Fix lint",
		description: "Fix all lint errors",
	});

	const all = await listTasks(teamDir, taskListId);
	assertEq(all.length, 2, "listTasks returns 2");

	const fetched = await getTask(teamDir, taskListId, t1.id);
	assertEq(fetched?.subject, "Write tests", "getTask returns correct task");

	// update
	const updated = await updateTask(teamDir, taskListId, t1.id, (cur) => ({
		...cur,
		status: "in_progress",
	}));
	assertEq(updated?.status, "in_progress", "updateTask changes status");

	// startAssignedTask — requires task.owner === agentName && status === pending
	// First assign t2 to agent2, then start it
	await updateTask(teamDir, taskListId, t2.id, (cur) => ({ ...cur, owner: "agent2" }));
	await startAssignedTask(teamDir, taskListId, t2.id, "agent2");
	const t2after = await getTask(teamDir, taskListId, t2.id);
	assertEq(t2after?.status, "in_progress", "startAssignedTask sets in_progress");
	assertEq(t2after?.owner, "agent2", "startAssignedTask preserves owner");

	// completeTask
	await completeTask(teamDir, taskListId, t1.id, "agent1", "All tests passing");
	const t1done = await getTask(teamDir, taskListId, t1.id);
	assertEq(t1done?.status, "completed", "completeTask sets completed");

	// formatTaskLine
	assert(t1done !== null, "completed task can be re-fetched");
	if (t1done) {
		const line = formatTaskLine(t1done);
		assert(line.includes("completed"), "formatTaskLine includes status");
		assert(line.includes("Write tests"), "formatTaskLine includes subject");
	}

	// claimNextAvailableTask
	const t3 = await createTask(teamDir, taskListId, {
		subject: "Unclaimed task",
		description: "nobody owns this",
	});
	const claimed = await claimNextAvailableTask(teamDir, taskListId, "agent3");
	assert(claimed !== null, "claimNextAvailableTask finds a task");
	assertEq(claimed?.owner, "agent3", "claimed task now owned by agent3");

	// unassignTasksForAgent — unassigns all non-completed tasks for agent
	// agent3 claimed a task above, unassign it
	await unassignTasksForAgent(teamDir, taskListId, "agent3", "agent3 left");
	const t3unassigned = await getTask(teamDir, taskListId, t3.id);
	assertEq(t3unassigned?.owner, undefined, "unassignTasksForAgent clears owner");

	// dependencies
	const depRes = await addTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(depRes.ok, "addTaskDependency ok");
	const t3fetched = await getTask(teamDir, taskListId, t3.id);
	assert(t3fetched !== null, "getTask returns dependency task");
	const blocked = t3fetched ? await isTaskBlocked(teamDir, taskListId, t3fetched) : false;
	assert(blocked, "task is blocked by dependency");

	const rmDep = await removeTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(rmDep.ok, "removeTaskDependency ok");

	// clearTasks (completed only)
	const clearResult = await clearTasks(teamDir, taskListId, "completed");
	assert(clearResult.deletedTaskIds.length >= 1, "clearTasks deleted completed tasks");
	assert(clearResult.skippedTaskIds.length >= 1, "clearTasks skipped non-completed");
}

// ── 5. team-config ───────────────────────────────────────────────────
console.log("\n5. team-config");
{
	const cfg = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg.version, 1, "config version 1");
	assertEq(cfg.teamId, "smoke-team", "teamId set");
	assert(cfg.members.length >= 1, "has at least lead member");
	const firstMember = cfg.members.at(0);
	assert(firstMember !== undefined, "first member exists");
	if (firstMember) assertEq(firstMember.role, "lead", "first member is lead");

	// idempotent
	const cfg2 = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg2.teamId, cfg.teamId, "ensureTeamConfig idempotent");

	// upsertMember
	const cfg3 = await upsertMember(teamDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});
	assert(cfg3.members.some((m) => m.name === "agent1" && m.role === "worker"), "upsertMember adds worker");

	// setMemberStatus
	const cfg4 = await setMemberStatus(teamDir, "agent1", "offline");
	assert(cfg4 !== null, "setMemberStatus returns config");
	if (cfg4) {
		assert(
			cfg4.members.some((m) => m.name === "agent1" && m.status === "offline"),
			"setMemberStatus changes status",
		);
	}

	// loadTeamConfig
	const loaded = await loadTeamConfig(teamDir);
	assert(loaded !== null, "loadTeamConfig returns config");
	assertEq(loaded?.teamId, "smoke-team", "loadTeamConfig correct teamId");
}

// ── 6. protocol parsers ──────────────────────────────────────────────
console.log("\n6. protocol parsers");
{
	// idle notification
	const idle = isIdleNotification(
		JSON.stringify({ type: "idle_notification", from: "agent1", timestamp: "2025-01-01T00:00:00Z" }),
	);
	assert(idle !== null, "isIdleNotification parses valid");
	assertEq(idle?.from, "agent1", "idle.from correct");

	assert(isIdleNotification("not json") === null, "isIdleNotification rejects garbage");
	assert(isIdleNotification(JSON.stringify({ type: "other" })) === null, "rejects wrong type");

	// task assignment
	const assign = isTaskAssignmentMessage(
		JSON.stringify({ type: "task_assignment", taskId: "42", subject: "Do stuff" }),
	);
	assert(assign !== null, "isTaskAssignmentMessage parses valid");
	assertEq(assign?.taskId, "42", "assign.taskId correct");

	// shutdown request
	const shutReq = isShutdownRequestMessage(
		JSON.stringify({ type: "shutdown_request", requestId: "r1", from: "lead", reason: "done" }),
	);
	assert(shutReq !== null, "isShutdownRequestMessage parses valid");
	assertEq(shutReq?.requestId, "r1", "shutReq.requestId correct");

	// shutdown approved / rejected
	const approved = isShutdownApproved(
		JSON.stringify({ type: "shutdown_approved", requestId: "r1", from: "agent1" }),
	);
	assert(approved !== null, "isShutdownApproved parses valid");

	const rejected = isShutdownRejected(
		JSON.stringify({ type: "shutdown_rejected", requestId: "r1", from: "agent1", reason: "busy" }),
	);
	assert(rejected !== null, "isShutdownRejected parses valid");

	// set session name
	const setName = isSetSessionNameMessage(JSON.stringify({ type: "set_session_name", name: "my session" }));
	assert(setName !== null, "isSetSessionNameMessage parses valid");
	assertEq(setName?.name, "my session", "setName.name correct");

	// plan approval request
	const planReq = isPlanApprovalRequest(
		JSON.stringify({ type: "plan_approval_request", requestId: "p1", from: "agent1", plan: "do X then Y" }),
	);
	assert(planReq !== null, "isPlanApprovalRequest parses valid");

	// plan approved / rejected
	const planOk = isPlanApprovedMessage(
		JSON.stringify({ type: "plan_approved", requestId: "p1", from: "lead", timestamp: "t" }),
	);
	assert(planOk !== null, "isPlanApprovedMessage parses valid");

	const planNo = isPlanRejectedMessage(
		JSON.stringify({ type: "plan_rejected", requestId: "p1", from: "lead", feedback: "redo" }),
	);
	assert(planNo !== null, "isPlanRejectedMessage parses valid");

	// peer DM
	const dm = isPeerDmSent(
		JSON.stringify({ type: "peer_dm_sent", from: "a1", to: "a2", summary: "hi" }),
	);
	assert(dm !== null, "isPeerDmSent parses valid");

	// abort
	const abort = isAbortRequestMessage(
		JSON.stringify({ type: "abort_request", requestId: "ab1", from: "lead", taskId: "5" }),
	);
	assert(abort !== null, "isAbortRequestMessage parses valid");
}

// ── 7. Pi CLI extension loading (non-interactive) ────────────────────
console.log("\n7. Pi extension loading");
{
	const { spawnSync } = await import("node:child_process");

	// `pi` is expected to be installed in local dev, but it's usually not available in CI.
	// Even locally, it may hang due to user-specific config, so treat this as a best-effort check.
	const res = spawnSync("pi", ["--version"], {
		cwd: process.cwd(),
		timeout: 3_000,
		encoding: "utf8",
	});

	const errCode = (() => {
		const e: unknown = res.error;
		if (!e || typeof e !== "object") return undefined;
		const c = (e as { code?: unknown }).code;
		return typeof c === "string" ? c : undefined;
	})();

	if (errCode === "ENOENT") {
		console.log("  (skipped) pi CLI not found on PATH");
	} else if (errCode === "ETIMEDOUT") {
		console.log("  (skipped) pi --version timed out");
	} else if (res.status !== 0) {
		console.log("  (skipped) pi --version returned non-zero exit code");
	} else {
		assert((res.stdout ?? "").trim().length > 0, "pi --version works");
	}
}

// ── 8. styles (custom + naming rules) ───────────────────────────────
console.log("\n8. teams-style (custom styles)");
{
	const prev = process.env.PI_TEAMS_ROOT_DIR;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;

	// Write a custom style under <teamsRoot>/_styles/
	const stylesDir = path.join(tmpRoot, "_styles");
	fs.mkdirSync(stylesDir, { recursive: true });
	fs.writeFileSync(
		path.join(stylesDir, "smoke-custom.json"),
		JSON.stringify(
			{
				extends: "pirate",
				strings: { memberTitle: "Deckhand", memberPrefix: "Deckhand " },
				naming: {
					requireExplicitSpawnName: false,
					autoNameStrategy: { kind: "pool", pool: ["pegleg"], fallbackBase: "deckhand" },
				},
			},
			null,
			2,
		) + "\n",
		"utf8",
	);

	const s = getTeamsStrings("smoke-custom");
	assertEq(s.memberTitle, "Deckhand", "custom style overrides strings");
	const naming = getTeamsNamingRules("smoke-custom");
	assert(naming.requireExplicitSpawnName === false, "custom style naming rules parsed");
	assert(naming.autoNameStrategy.kind === "pool", "custom style can use pool naming");
	if (naming.autoNameStrategy.kind === "pool") {
		assertEq(naming.autoNameStrategy.fallbackBase, "deckhand", "custom style fallbackBase parsed");
		assertEq(naming.autoNameStrategy.pool.at(0), "pegleg", "custom style pool parsed");
	}

	// restore env
	if (prev === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prev;
}

// ── 9. hooks (quality gates) ────────────────────────────────────────
console.log("\n9. teams-hooks (quality gates)");
{
	const prevRoot = process.env.PI_TEAMS_ROOT_DIR;
	const prevEnabled = process.env.PI_TEAMS_HOOKS_ENABLED;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;
	process.env.PI_TEAMS_HOOKS_ENABLED = "1";

	const hooksDir = path.join(tmpRoot, "_hooks");
	fs.mkdirSync(hooksDir, { recursive: true });

	const outFile = path.join(tmpRoot, "hook-ran.txt");
	fs.writeFileSync(
		path.join(hooksDir, "on_task_completed.js"),
		"" +
			"const fs = require('node:fs');\n" +
			`fs.writeFileSync(${JSON.stringify(outFile)}, 'ok\\n', 'utf8');\n` +
			"process.exit(0);\n",
		"utf8",
	);

	const teamId = "smoke-team";
	const teamDir = path.join(tmpRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });

	const res = await runTeamsHook({
		invocation: {
			event: "task_completed",
			teamId,
			teamDir,
			taskListId: teamId,
			style: "pirate",
			memberName: "agent1",
			timestamp: new Date().toISOString(),
			completedTask: {
				id: "1",
				subject: "Test task",
				description: "",
				owner: "agent1",
				status: "completed",
				blocks: [],
				blockedBy: [],
				metadata: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		},
		cwd: tmpRoot,
	});

	assert(res.ran === true, "runs on_task_completed hook");
	assert(res.exitCode === 0, "hook exit code is 0");
	assert(fs.existsSync(outFile), "hook wrote output file");

	// restore env
	if (prevRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prevRoot;
	if (prevEnabled === undefined) delete process.env.PI_TEAMS_HOOKS_ENABLED;
	else process.env.PI_TEAMS_HOOKS_ENABLED = prevEnabled;
}

// ── 10. team discovery (attach flow) ────────────────────────────────
console.log("\n10. team discovery (attach flow)");
{
	const discoverRoot = path.join(tmpRoot, "discover-root");
	const aDir = path.join(discoverRoot, "team-a");
	const bDir = path.join(discoverRoot, "team-b");
	fs.mkdirSync(path.join(discoverRoot, "_styles"), { recursive: true });

	await ensureTeamConfig(aDir, {
		teamId: "team-a",
		taskListId: "tasks-a",
		leadName: "team-lead",
		style: "normal",
	});
	await ensureTeamConfig(bDir, {
		teamId: "team-b",
		taskListId: "tasks-b",
		leadName: "team-lead",
		style: "pirate",
	});
	await upsertMember(bDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});

	const discovered = await listDiscoveredTeams(discoverRoot);
	assert(discovered.some((t) => t.teamId === "team-a"), "discovers first team");
	assert(discovered.some((t) => t.teamId === "team-b"), "discovers second team");
	assert(!discovered.some((t) => t.teamId.startsWith("_")), "ignores internal directories");
	const b = discovered.find((t) => t.teamId === "team-b");
	assert(b !== undefined, "team-b discovered");
	if (b) {
		assertEq(b.taskListId, "tasks-b", "discovered taskListId");
		assertEq(b.style, "pirate", "discovered style");
		assertEq(b.onlineWorkerCount, 1, "discovered online worker count");
	}
}

// ── 11. docs/help drift guard ────────────────────────────────────────
console.log("\n11. docs/help drift guard");
{
	const help = getTeamHelpText();
	assert(help.includes("/team style list"), "help mentions /team style list");
	assert(help.includes("/team style init"), "help mentions /team style init");
	assert(help.includes("/team attach <teamId>"), "help mentions /team attach");
	assert(help.includes("/team detach"), "help mentions /team detach");

	const readmePath = path.join(process.cwd(), "README.md");
	if (!fs.existsSync(readmePath)) {
		console.log("  (skipped) README.md not found");
	} else {
		const readme = fs.readFileSync(readmePath, "utf8");
		assert(readme.includes("/team style list"), "README mentions /team style list");
		assert(readme.includes("/team attach <teamId>"), "README mentions /team attach");
		assert(readme.includes("/team detach"), "README mentions /team detach");
		assert(readme.includes("\"action\": \"task_assign\""), "README mentions teams tool task_assign action");
		assert(readme.includes("task-centric view"), "README mentions panel task-centric view");
		assert(readme.includes("task view: `c` complete"), "README mentions panel task mutations");
		assert(readme.includes("`r` reassign"), "README mentions panel task reassignment");
		assert(readme.includes("_styles"), "README mentions _styles directory");
	}
}

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
console.log(`${"═".repeat(50)}\n`);

// cleanup
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
