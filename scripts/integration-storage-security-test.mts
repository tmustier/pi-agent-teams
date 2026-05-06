import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import { withLock } from "../extensions/teams/fs-lock.js";
import { getTeamDir, validateTeamId } from "../extensions/teams/paths.js";
import { createTask, addTaskDependency, removeTaskDependency, getTask } from "../extensions/teams/task-store.js";
import { gcStaleTeamDirs } from "../extensions/teams/cleanup.js";
import { ensureWorktreeCwd } from "../extensions/teams/worktree.js";

const exec = promisify(execFile);

async function tempDir(prefix: string): Promise<string> {
	return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function testTeamIdValidation(): Promise<void> {
	const root = await tempDir("pi-teams-storage-root-");
	process.env.PI_TEAMS_ROOT_DIR = root;
	assert.equal(validateTeamId("safe-team_123"), null);
	assert.match(validateTeamId("../escape") ?? "", /path separators|traversal/);
	assert.throws(() => getTeamDir("../escape"), /Invalid teamId/);
	assert.equal(getTeamDir("safe-team_123"), path.join(root, "safe-team_123"));
}

async function testLockDoesNotStealLiveHolder(): Promise<void> {
	const dir = await tempDir("pi-teams-lock-");
	const lock = path.join(dir, "x.lock");
	let holderEntered = false;
	const holder = withLock(lock, async () => {
		holderEntered = true;
		await new Promise((r) => setTimeout(r, 650));
	}, { staleMs: 150, pollMs: 20, timeoutMs: 2_000, label: "holder" });

	while (!holderEntered) await new Promise((r) => setTimeout(r, 10));
	await new Promise((r) => setTimeout(r, 250));
	await assert.rejects(
		() => withLock(lock, async () => "stolen", { staleMs: 150, pollMs: 20, timeoutMs: 120, label: "contender" }),
		/Timeout acquiring lock/,
	);
	await holder;
	const ok = await withLock(lock, async () => "ok", { staleMs: 150, pollMs: 20, timeoutMs: 500 });
	assert.equal(ok, "ok");
}

async function testTaskDependencyTransaction(): Promise<void> {
	const teamDir = await tempDir("pi-teams-tasks-");
	const a = await createTask(teamDir, "list", { subject: "a", description: "a" });
	const b = await createTask(teamDir, "list", { subject: "b", description: "b" });
	const added = await addTaskDependency(teamDir, "list", a.id, b.id);
	assert.equal(added.ok, true);
	assert.deepEqual((await getTask(teamDir, "list", a.id))?.blockedBy, [b.id]);
	assert.deepEqual((await getTask(teamDir, "list", b.id))?.blocks, [a.id]);
	const removed = await removeTaskDependency(teamDir, "list", a.id, b.id);
	assert.equal(removed.ok, true);
	assert.deepEqual((await getTask(teamDir, "list", a.id))?.blockedBy, []);
	assert.deepEqual((await getTask(teamDir, "list", b.id))?.blocks, []);
}

async function testGcExcludesAndClaims(): Promise<void> {
	const root = await tempDir("pi-teams-gc-");
	const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	for (const id of ["current", "claimed", "stale"]) {
		const dir = path.join(root, id);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(path.join(dir, "config.json"), JSON.stringify({ teamId: id, createdAt: oldIso, members: [] }));
	}
	await fs.promises.writeFile(path.join(root, "claimed", ".attach-claim.json"), JSON.stringify({ heartbeatAt: new Date().toISOString(), holderSessionId: "s" }));
	const result = await gcStaleTeamDirs({ teamsRootDir: root, maxAgeMs: 24 * 60 * 60 * 1000, excludeTeamIds: new Set(["current"]) });
	assert.deepEqual(result.removed, ["stale"]);
	assert.equal(fs.existsSync(path.join(root, "current")), true);
	assert.equal(fs.existsSync(path.join(root, "claimed")), true);
	assert.equal(fs.existsSync(path.join(root, "stale")), false);
}

async function testWorktreeSymlinkReuseRejected(): Promise<void> {
	const repo = await tempDir("pi-teams-repo-");
	await exec("git", ["init"], { cwd: repo });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	await exec("git", ["config", "user.name", "Test"], { cwd: repo });
	await fs.promises.writeFile(path.join(repo, "README.md"), "x\n");
	await exec("git", ["add", "README.md"], { cwd: repo });
	await exec("git", ["commit", "-m", "init"], { cwd: repo });

	const teamDir = await tempDir("pi-teams-worktree-");
	const worktreesDir = path.join(teamDir, "worktrees");
	await fs.promises.mkdir(worktreesDir, { recursive: true });
	await fs.promises.symlink(os.tmpdir(), path.join(worktreesDir, "agent"));
	const res = await ensureWorktreeCwd({ leaderCwd: repo, teamDir, teamId: "team", agentName: "agent" });
	assert.equal(res.mode, "shared");
	assert.match(res.warnings.join("\n"), /Refusing to reuse unsafe worktree path/);
}

await testTeamIdValidation();
await testLockDoesNotStealLiveHolder();
await testTaskDependencyTransaction();
await testGcExcludesAndClaims();
await testWorktreeSymlinkReuseRejected();
console.log("integration-storage-security-test ok");
