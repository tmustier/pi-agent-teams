import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/jiti");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
});

const root = process.cwd();
const teamConfig = jiti(path.join(root, "extensions/teams/team-config.ts"));
const mailbox = jiti(path.join(root, "extensions/teams/mailbox.ts"));
const taskStore = jiti(path.join(root, "extensions/teams/task-store.ts"));
const cleanup = jiti(path.join(root, "extensions/teams/cleanup.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-smoke-"));
const teamId = "TEAM123";
const taskListId = teamId;
const teamDir = path.join(tmpRoot, "teams", teamId);

console.log("tmpRoot:", tmpRoot);

// -----------------------------------------------------------------------------
// Team config
// -----------------------------------------------------------------------------
{
	const cfg = await teamConfig.ensureTeamConfig(teamDir, { teamId, taskListId, leadName: "team-lead" });
	assert.equal(cfg.teamId, teamId);
	assert.equal(cfg.taskListId, taskListId);
	assert.equal(cfg.leadName, "team-lead");
	assert.ok(cfg.members.find((m) => m.name === "team-lead" && m.role === "lead"));

	await teamConfig.upsertMember(teamDir, { name: "alice", role: "worker", status: "online" });
	const cfg2 = await teamConfig.loadTeamConfig(teamDir);
	assert.ok(cfg2);
	assert.ok(cfg2.members.find((m) => m.name === "alice" && m.status === "online"));

	await teamConfig.setMemberStatus(teamDir, "alice", "offline", { meta: { reason: "test" } });
	const cfg3 = await teamConfig.loadTeamConfig(teamDir);
	assert.ok(cfg3);
	assert.ok(cfg3.members.find((m) => m.name === "alice" && m.status === "offline"));
}

// -----------------------------------------------------------------------------
// Mailbox
// -----------------------------------------------------------------------------
{
	await mailbox.writeToMailbox(teamDir, "team", "team-lead", {
		from: "alice",
		text: JSON.stringify({ type: "idle_notification", from: "alice", timestamp: new Date().toISOString() }),
		timestamp: new Date().toISOString(),
	});

	const msgs = await mailbox.popUnreadMessages(teamDir, "team", "team-lead");
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0].from, "alice");

	const msgs2 = await mailbox.popUnreadMessages(teamDir, "team", "team-lead");
	assert.equal(msgs2.length, 0);
}

// -----------------------------------------------------------------------------
// Task store
// -----------------------------------------------------------------------------
{
	const t1 = await taskStore.createTask(teamDir, taskListId, { subject: "Smoke task 1", description: "Do thing" });
	assert.equal(t1.id, "1");

	const t2 = await taskStore.createTask(teamDir, taskListId, { subject: "Smoke task 2", description: "Do other" });
	assert.equal(t2.id, "2");

	const t3 = await taskStore.createTask(teamDir, taskListId, { subject: "Smoke task 3", description: "Do third" });
	assert.equal(t3.id, "3");

	let tasks = await taskStore.listTasks(teamDir, taskListId);
	assert.equal(tasks.length, 3);

	// Dependencies: #2 depends on #1 (so #2 is blocked until #1 is completed)
	const depRes = await taskStore.addTaskDependency(teamDir, taskListId, "2", "1");
	assert.ok(depRes.ok);

	const t1AfterDep = await taskStore.getTask(teamDir, taskListId, "1");
	const t2AfterDep = await taskStore.getTask(teamDir, taskListId, "2");
	assert.ok(t1AfterDep);
	assert.ok(t2AfterDep);
	assert.ok(t1AfterDep.blocks.includes("2"));
	assert.ok(t2AfterDep.blockedBy.includes("1"));
	assert.equal(await taskStore.isTaskBlocked(teamDir, taskListId, t2AfterDep), true);

	const claimed = await taskStore.claimNextAvailableTask(teamDir, taskListId, "alice", { checkAgentBusy: true });
	assert.ok(claimed);
	assert.equal(claimed.id, "1");
	assert.equal(claimed.owner, "alice");
	assert.equal(claimed.status, "in_progress");

	// Blocked self-claim: bob should skip #2 (blocked) and claim #3
	const claimedBob = await taskStore.claimNextAvailableTask(teamDir, taskListId, "bob", { checkAgentBusy: true });
	assert.ok(claimedBob);
	assert.equal(claimedBob.id, "3");
	assert.equal(claimedBob.owner, "bob");

	// Busy check: should refuse a second claim while alice has in_progress
	const claimed2 = await taskStore.claimNextAvailableTask(teamDir, taskListId, "alice", { checkAgentBusy: true });
	assert.equal(claimed2, null);

	await taskStore.completeTask(teamDir, taskListId, claimed.id, "alice", "done");

	const t2AfterDepDone = await taskStore.getTask(teamDir, taskListId, "2");
	assert.ok(t2AfterDepDone);
	assert.equal(await taskStore.isTaskBlocked(teamDir, taskListId, t2AfterDepDone), false);

	// Now alice can claim #2
	const claimed3 = await taskStore.claimNextAvailableTask(teamDir, taskListId, "alice", { checkAgentBusy: true });
	assert.ok(claimed3);
	assert.equal(claimed3.id, "2");

	// Create an additional pending task owned by alice (simulates assigned-but-not-started)
	const t4 = await taskStore.createTask(teamDir, taskListId, {
		subject: "Smoke task 4",
		description: "Do fourth",
		owner: "alice",
	});
	assert.equal(t4.id, "4");
	assert.equal(t4.owner, "alice");
	assert.equal(t4.status, "pending");

	// Unassign a single task (should only unassign task 2, leaving task 4 assigned)
	await taskStore.unassignTask(teamDir, taskListId, claimed3.id, "alice", "test abort", { abortedBy: "alice" });

	tasks = await taskStore.listTasks(teamDir, taskListId);
	const t2After = tasks.find((t) => t.id === "2");
	assert.ok(t2After);
	assert.equal(t2After.owner, undefined);
	assert.equal(t2After.status, "pending");

	const t4After = tasks.find((t) => t.id === "4");
	assert.ok(t4After);
	assert.equal(t4After.owner, "alice");
	assert.equal(t4After.status, "pending");

	// Unassign remaining non-completed tasks for alice (should unassign task 4)
	const unassignedCount = await taskStore.unassignTasksForAgent(teamDir, taskListId, "alice", "test unassign");
	assert.equal(unassignedCount, 1);

	tasks = await taskStore.listTasks(teamDir, taskListId);
	const t4After2 = tasks.find((t) => t.id === "4");
	assert.ok(t4After2);
	assert.equal(t4After2.owner, undefined);
	assert.equal(t4After2.status, "pending");

	// Complete bob's task so clear(completed) deletes both #1 and #3
	await taskStore.completeTask(teamDir, taskListId, claimedBob.id, "bob", "done");

	// Clear completed tasks (should delete tasks 1 + 3)
	const clearedCompleted = await taskStore.clearTasks(teamDir, taskListId, "completed");
	assert.equal(clearedCompleted.errors.length, 0);
	assert.deepEqual([...clearedCompleted.deletedTaskIds].sort(), ["1", "3"]);

	tasks = await taskStore.listTasks(teamDir, taskListId);
	assert.equal(tasks.length, 2);
	assert.deepEqual(
		tasks.map((t) => t.id).sort(),
		["2", "4"],
	);

	// Clear all remaining tasks
	const clearedAll = await taskStore.clearTasks(teamDir, taskListId, "all");
	assert.equal(clearedAll.errors.length, 0);

	tasks = await taskStore.listTasks(teamDir, taskListId);
	assert.equal(tasks.length, 0);
}

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------
{
	const teamsRootDir = path.join(tmpRoot, "teams");

	// Put a sentinel file in the team dir, then delete it.
	fs.mkdirSync(teamDir, { recursive: true });
	fs.writeFileSync(path.join(teamDir, "sentinel.txt"), "sentinel");

	await cleanup.cleanupTeamDir(teamsRootDir, teamDir);
	assert.equal(fs.existsSync(teamDir), false);

	// Refuse unsafe paths
	await assert.rejects(
		() => cleanup.cleanupTeamDir(teamsRootDir, path.join(tmpRoot, "outside", "TEAM123")),
		/Refusing to operate on path outside teams root/,
	);
	await assert.rejects(() => cleanup.cleanupTeamDir(teamsRootDir, teamsRootDir), /Refusing to operate on path outside teams root/);
}

console.log("OK: smoke test passed");
