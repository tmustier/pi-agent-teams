/**
 * Integration test for team cleanup and garbage collection.
 *
 * Tests: cleanupTeamDir (with worktree removal), gcStaleTeamDirs,
 *        cleanupWorktrees (git worktree + branch lifecycle).
 *
 * Requires: git (creates temporary git repos and worktrees).
 *
 * Usage:  npx tsx scripts/integration-cleanup-test.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { cleanupTeamDir, gcStaleTeamDirs, assertTeamDirWithinTeamsRoot } from "../extensions/teams/cleanup.js";
import { cleanupWorktrees } from "../extensions/teams/worktree.js";
import { ensureTeamConfig } from "../extensions/teams/team-config.js";
import { createTask } from "../extensions/teams/task-store.js";

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

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
}

function gitLines(args: string[], cwd: string): string[] {
	return git(args, cwd).split("\n").filter((l) => l.length > 0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-cleanup-"));
console.log(`\nCleanup test root: ${tmpRoot}\n`);

// ── setup: create a temporary git repo ────────────────────────────
const repoDir = path.join(tmpRoot, "repo");
fs.mkdirSync(repoDir, { recursive: true });
git(["init"], repoDir);
git(["config", "user.email", "test@test.com"], repoDir);
git(["config", "user.name", "Test"], repoDir);
fs.writeFileSync(path.join(repoDir, "README.md"), "# Test repo\n");
git(["add", "."], repoDir);
git(["commit", "-m", "init"], repoDir);

const teamsRoot = path.join(tmpRoot, "teams");
fs.mkdirSync(teamsRoot, { recursive: true });

// ── Test 1: assertTeamDirWithinTeamsRoot ─────────────────────────
console.log("1. assertTeamDirWithinTeamsRoot");
{
	const result = assertTeamDirWithinTeamsRoot(teamsRoot, path.join(teamsRoot, "team-1"));
	assert(result.teamDirAbs.includes("team-1"), "accepts child dir");

	let threw = false;
	try {
		assertTeamDirWithinTeamsRoot(teamsRoot, teamsRoot);
	} catch {
		threw = true;
	}
	assert(threw, "rejects same dir");

	threw = false;
	try {
		assertTeamDirWithinTeamsRoot(teamsRoot, path.join(teamsRoot, ".."));
	} catch {
		threw = true;
	}
	assert(threw, "rejects parent dir");
}

// ── Test 2: cleanupWorktrees on empty dir ────────────────────────
console.log("\n2. cleanupWorktrees (no worktrees)");
{
	const teamDir = path.join(teamsRoot, "team-no-wt");
	fs.mkdirSync(teamDir, { recursive: true });

	const result = await cleanupWorktrees({ teamDir, teamId: "team-no-wt", repoCwd: repoDir });
	assertEq(result.removedWorktrees.length, 0, "no worktrees removed");
	assertEq(result.removedBranches.length, 0, "no branches removed");
	assertEq(result.warnings.length, 0, "no warnings");
}

// ── Test 3: cleanupWorktrees removes worktrees and branches ──────
console.log("\n3. cleanupWorktrees (with worktrees + branches)");
{
	const teamId = "team-wt-test";
	const teamDir = path.join(teamsRoot, teamId);
	const wtDir = path.join(teamDir, "worktrees");
	fs.mkdirSync(wtDir, { recursive: true });

	const shortTeam = teamId.slice(0, 12);
	const agent1Path = path.join(wtDir, "agent1");
	const agent2Path = path.join(wtDir, "agent2");
	const branch1 = `pi-teams/${shortTeam}/agent1`;
	const branch2 = `pi-teams/${shortTeam}/agent2`;

	// Create worktrees using git
	git(["worktree", "add", "-b", branch1, agent1Path, "HEAD"], repoDir);
	git(["worktree", "add", "-b", branch2, agent2Path, "HEAD"], repoDir);

	// Verify they exist
	const wtListBefore = gitLines(["worktree", "list", "--porcelain"], repoDir);
	const branchesBefore = gitLines(["branch"], repoDir);
	assert(wtListBefore.some((l) => l.includes("agent1")), "worktree agent1 exists before cleanup");
	assert(wtListBefore.some((l) => l.includes("agent2")), "worktree agent2 exists before cleanup");
	assert(branchesBefore.some((l) => l.includes(branch1)), "branch1 exists before cleanup");
	assert(branchesBefore.some((l) => l.includes(branch2)), "branch2 exists before cleanup");

	// Clean up
	const result = await cleanupWorktrees({ teamDir, teamId, repoCwd: repoDir });
	assertEq(result.removedWorktrees.length, 2, "2 worktrees removed");
	assertEq(result.removedBranches.length, 2, "2 branches removed");
	assert(result.removedBranches.includes(branch1), "branch1 in removed list");
	assert(result.removedBranches.includes(branch2), "branch2 in removed list");

	// Verify they're gone
	const wtListAfter = gitLines(["worktree", "list", "--porcelain"], repoDir);
	const branchesAfter = gitLines(["branch"], repoDir);
	assert(!wtListAfter.some((l) => l.includes("agent1")), "worktree agent1 removed after cleanup");
	assert(!wtListAfter.some((l) => l.includes("agent2")), "worktree agent2 removed after cleanup");
	assert(!branchesAfter.some((l) => l.includes(branch1)), "branch1 removed after cleanup");
	assert(!branchesAfter.some((l) => l.includes(branch2)), "branch2 removed after cleanup");

	// Worktrees dir itself should be removed (empty)
	assert(!fs.existsSync(wtDir), "worktrees dir removed");
}

// ── Test 4: cleanupTeamDir removes worktrees + entire dir ────────
console.log("\n4. cleanupTeamDir (full cleanup including worktrees)");
{
	const teamId = "team-full-cleanup";
	const teamDir = path.join(teamsRoot, teamId);
	const wtDir = path.join(teamDir, "worktrees");
	fs.mkdirSync(wtDir, { recursive: true });

	const shortTeam = teamId.slice(0, 12);
	const agentPath = path.join(wtDir, "worker1");
	const branch = `pi-teams/${shortTeam}/worker1`;

	git(["worktree", "add", "-b", branch, agentPath, "HEAD"], repoDir);

	// Also create some team artifacts
	await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "lead", style: "normal" });
	fs.mkdirSync(path.join(teamDir, "mailboxes"), { recursive: true });
	fs.writeFileSync(path.join(teamDir, "mailboxes", "test.json"), "[]");

	assert(fs.existsSync(teamDir), "team dir exists before cleanup");
	assert(fs.existsSync(agentPath), "worktree path exists before cleanup");

	const result = await cleanupTeamDir(teamsRoot, teamDir, { teamId, repoCwd: repoDir });
	assert(!fs.existsSync(teamDir), "team dir removed");
	assertEq(result.worktreeResult.removedWorktrees.length, 1, "1 worktree removed");
	assertEq(result.worktreeResult.removedBranches.length, 1, "1 branch removed");

	// Verify git state
	const branches = gitLines(["branch"], repoDir);
	assert(!branches.some((l) => l.includes(branch)), "branch removed from git");
}

// ── Test 5: gcStaleTeamDirs basic flow ───────────────────────────
console.log("\n5. gcStaleTeamDirs (basic)");
{
	// Create 3 team dirs: old-idle, old-active (online worker), recent-idle
	const oldIdleDir = path.join(teamsRoot, "old-idle");
	fs.mkdirSync(oldIdleDir, { recursive: true });
	await ensureTeamConfig(oldIdleDir, { teamId: "old-idle", taskListId: "old-idle", leadName: "lead", style: "normal" });
	// Backdate both the directory mtime AND the config.json createdAt.
	// NOTE: the lead member stays status: "online" (as ensureTeamConfig creates it).
	// GC must ignore the lead's status — only workers count.
	const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	const oldIdleConfig = JSON.parse(fs.readFileSync(path.join(oldIdleDir, "config.json"), "utf8"));
	oldIdleConfig.createdAt = twoDaysAgo.toISOString();
	fs.writeFileSync(path.join(oldIdleDir, "config.json"), JSON.stringify(oldIdleConfig, null, 2));
	fs.utimesSync(oldIdleDir, twoDaysAgo, twoDaysAgo);

	const oldActiveDir = path.join(teamsRoot, "old-active");
	fs.mkdirSync(oldActiveDir, { recursive: true });
	await ensureTeamConfig(oldActiveDir, { teamId: "old-active", taskListId: "old-active", leadName: "lead", style: "normal" });
	// Add an online *worker* (role: "worker") and backdate — GC must keep this.
	const configPath = path.join(oldActiveDir, "config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	config.members = [
		{ name: "lead", role: "lead", status: "online" },
		{ name: "worker1", role: "worker", status: "online" },
	];
	config.createdAt = twoDaysAgo.toISOString();
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	fs.utimesSync(oldActiveDir, twoDaysAgo, twoDaysAgo);

	const recentDir = path.join(teamsRoot, "recent-idle");
	fs.mkdirSync(recentDir, { recursive: true });
	await ensureTeamConfig(recentDir, { teamId: "recent-idle", taskListId: "recent-idle", leadName: "lead", style: "normal" });

	// Dry run — should identify old-idle for removal
	const dryResult = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000, // 24h
		repoCwd: repoDir,
		dryRun: true,
	});

	assert(dryResult.removed.includes("old-idle"), "dry run: old-idle marked for removal");
	assert(!dryResult.removed.includes("old-active"), "dry run: old-active NOT marked (has online member)");
	assert(!dryResult.removed.includes("recent-idle"), "dry run: recent-idle NOT marked (too new)");
	assert(fs.existsSync(oldIdleDir), "dry run: old-idle still exists");

	// Actual run
	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: false,
	});

	assert(result.removed.includes("old-idle"), "gc: old-idle removed");
	assert(!result.removed.includes("old-active"), "gc: old-active kept");
	assert(!fs.existsSync(oldIdleDir), "gc: old-idle dir deleted from disk");
	assert(fs.existsSync(oldActiveDir), "gc: old-active dir still exists");
	assert(fs.existsSync(recentDir), "gc: recent-idle dir still exists");
}

// ── Test 6: gcStaleTeamDirs skips dirs with in_progress tasks ───
console.log("\n6. gcStaleTeamDirs (in-progress tasks)");
{
	const teamId = "old-busy";
	const teamDir = path.join(teamsRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });
	await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "lead", style: "normal" });

	// Create an in_progress task
	const task = await createTask(teamDir, teamId, { subject: "test task", description: "busy" });
	const taskFile = path.join(teamDir, "tasks", teamId, `${task.id}.json`);
	const taskData = JSON.parse(fs.readFileSync(taskFile, "utf8"));
	taskData.status = "in_progress";
	taskData.owner = "agent1";
	fs.writeFileSync(taskFile, JSON.stringify(taskData, null, 2));

	// Backdate both config createdAt and dir mtime
	const oldBusyConfig = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
	const twoDaysAgoLocal = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	oldBusyConfig.createdAt = twoDaysAgoLocal.toISOString();
	fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(oldBusyConfig, null, 2));
	fs.utimesSync(teamDir, twoDaysAgoLocal, twoDaysAgoLocal);

	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: false,
	});

	assert(!result.removed.includes(teamId), "gc: old-busy NOT removed (in_progress task)");
	assert(fs.existsSync(teamDir), "gc: old-busy dir still exists");
	assert(result.skipped.some((s) => s.teamId === teamId && s.reason === "has active work"), "gc: skipped with reason");
}

// ── Test 7: gcStaleTeamDirs ignores online lead member ───────────
console.log("\n7. gcStaleTeamDirs (ignores online lead)");
{
	// ensureTeamConfig creates the lead as status: "online". GC must still
	// remove the team when no *workers* are online, even if the lead is.
	const teamId = "old-lead-only";
	const teamDir = path.join(teamsRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });
	await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "lead", style: "normal" });
	// Backdate — do NOT change lead status to offline.
	const twoDaysAgoLocal = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	const cfg = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
	cfg.createdAt = twoDaysAgoLocal.toISOString();
	fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(cfg, null, 2));
	fs.utimesSync(teamDir, twoDaysAgoLocal, twoDaysAgoLocal);

	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: false,
	});

	assert(result.removed.includes(teamId), "gc: team with only online lead is removed");
	assert(!fs.existsSync(teamDir), "gc: old-lead-only dir deleted");
}

// ── Test 8: gcStaleTeamDirs respects live attach claims ──────────
console.log("\n8. gcStaleTeamDirs (respects attach claims)");
{
	const teamId = "old-attached";
	const teamDir = path.join(teamsRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });
	await ensureTeamConfig(teamDir, { teamId, taskListId: teamId, leadName: "lead", style: "normal" });
	// Backdate the team — would normally be GC'd.
	const twoDaysAgoLocal = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	const cfg = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
	cfg.createdAt = twoDaysAgoLocal.toISOString();
	fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(cfg, null, 2));
	fs.utimesSync(teamDir, twoDaysAgoLocal, twoDaysAgoLocal);

	// Write a fresh attach claim (heartbeat is recent).
	const claimPath = path.join(teamDir, ".attach-claim.json");
	fs.writeFileSync(claimPath, JSON.stringify({
		holderSessionId: "other-session",
		claimedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
		pid: process.pid,
	}));

	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: false,
	});

	assert(!result.removed.includes(teamId), "gc: old-attached NOT removed (has live claim)");
	assert(fs.existsSync(teamDir), "gc: old-attached dir still exists");
	assert(result.skipped.some((s) => s.teamId === teamId && s.reason === "has active work"), "gc: skipped with reason");

	// Now test with a stale claim — should be removed.
	const staleClaim = {
		holderSessionId: "dead-session",
		claimedAt: twoDaysAgoLocal.toISOString(),
		heartbeatAt: twoDaysAgoLocal.toISOString(),
		pid: 99999,
	};
	fs.writeFileSync(claimPath, JSON.stringify(staleClaim));

	const result2 = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: false,
	});

	assert(result2.removed.includes(teamId), "gc: old-attached removed (stale claim)");
	assert(!fs.existsSync(teamDir), "gc: old-attached dir deleted after stale claim");
}

// ── Test 9: gcStaleTeamDirs ignores _styles and _hooks dirs ──────
console.log("\n9. gcStaleTeamDirs (ignores underscore dirs)");
{
	const stylesDir = path.join(teamsRoot, "_styles");
	const hooksDir = path.join(teamsRoot, "_hooks");
	fs.mkdirSync(stylesDir, { recursive: true });
	fs.mkdirSync(hooksDir, { recursive: true });
	const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	fs.utimesSync(stylesDir, twoDaysAgo, twoDaysAgo);
	fs.utimesSync(hooksDir, twoDaysAgo, twoDaysAgo);

	const result = await gcStaleTeamDirs({
		teamsRootDir: teamsRoot,
		maxAgeMs: 24 * 60 * 60 * 1000,
		repoCwd: repoDir,
		dryRun: true,
	});

	assert(!result.removed.includes("_styles"), "gc: _styles not targeted");
	assert(!result.removed.includes("_hooks"), "gc: _hooks not targeted");
}

// ── Test 10: cleanupWorktrees handles missing repo gracefully ────
console.log("\n10. cleanupWorktrees (no repo context)");
{
	const teamDir = path.join(teamsRoot, "no-repo");
	const wtDir = path.join(teamDir, "worktrees");
	const fakePath = path.join(wtDir, "fake-agent");
	fs.mkdirSync(fakePath, { recursive: true });
	fs.writeFileSync(path.join(fakePath, "some-file.txt"), "leftover");

	// No repoCwd, and the worktree isn't a valid git dir
	const result = await cleanupWorktrees({ teamDir, teamId: "no-repo" });
	assertEq(result.removedWorktrees.length, 1, "removed via filesystem fallback");
	assert(!fs.existsSync(fakePath), "fake-agent dir removed");
}

// ── cleanup ──────────────────────────────────────────────────────
console.log("\n─── Cleanup ───");
try {
	// Remove any remaining git worktrees from the test repo
	const wtList = gitLines(["worktree", "list", "--porcelain"], repoDir);
	for (const line of wtList) {
		if (line.startsWith("worktree ") && !line.includes(repoDir)) {
			const wtPath = line.replace("worktree ", "");
			try {
				git(["worktree", "remove", "--force", wtPath], repoDir);
			} catch {
				// ignore
			}
		}
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	console.log(`  Removed ${tmpRoot}`);
} catch (err) {
	console.warn(`  Warning: cleanup failed: ${err}`);
}

// ── summary ──────────────────────────────────────────────────────
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
