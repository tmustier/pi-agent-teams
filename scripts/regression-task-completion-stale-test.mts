import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { completeTask, createTask, getTask, startAssignedTask, updateTask } from "../extensions/teams/task-store.js";

const teamDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teams-task-stale-"));
const taskListId = "tasks";

try {
	const task = await createTask(teamDir, taskListId, {
		subject: "stale completion regression",
		description: "worker must not report completion after reassignment",
		owner: "agent1",
	});

	const started = await startAssignedTask(teamDir, taskListId, task.id, "agent1");
	assert.equal(started?.status, "in_progress");

	await updateTask(teamDir, taskListId, task.id, (cur) => ({
		...cur,
		owner: "agent2",
		status: "in_progress",
		metadata: { ...(cur.metadata ?? {}), reassignedForTest: true },
	}));

	const stale = await completeTask(teamDir, taskListId, task.id, "agent1", "agent1 result must not be stored");
	assert.equal(stale.ok, false);
	assert.equal(stale.reason, "not_owner");
	assert.equal(stale.task?.owner, "agent2");

	const afterStale = await getTask(teamDir, taskListId, task.id);
	assert.equal(afterStale?.owner, "agent2");
	assert.equal(afterStale?.status, "in_progress");
	assert.equal(afterStale?.metadata?.["result"], undefined);

	const completed = await completeTask(teamDir, taskListId, task.id, "agent2", "agent2 result");
	assert.equal(completed.ok, true);
	assert.equal(completed.task.status, "completed");
	assert.equal(completed.task.metadata?.["result"], "agent2 result");

	const duplicate = await completeTask(teamDir, taskListId, task.id, "agent2", "duplicate result must not overwrite");
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.reason, "already_completed");

	const afterDuplicate = await getTask(teamDir, taskListId, task.id);
	assert.equal(afterDuplicate?.metadata?.["result"], "agent2 result");

	console.log("PASS: stale worker completion is rejected and does not mutate the task");
} finally {
	await fs.rm(teamDir, { recursive: true, force: true });
}
