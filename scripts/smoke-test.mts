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
	const { execSync } = await import("node:child_process");

	// `pi` is expected to be installed in local dev, but it's usually not available in CI.
	const hasPi = (() => {
		try {
			execSync("command -v pi", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	})();

	if (!hasPi) {
		console.log("  (skipped) pi CLI not found on PATH");
	} else {
		try {
			const out = execSync("pi --version", {
				cwd: process.cwd(),
				timeout: 10_000,
				encoding: "utf8",
			});
			assert(out.trim().length > 0, "pi --version works");
		} catch (e) {
			assert(false, `pi --version failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
console.log(`${"═".repeat(50)}\n`);

// cleanup
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
