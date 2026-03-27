/**
 * Integration test: branch-mode worker sessions should strip the leader's
 * in-progress tool-use turn before starting delegated work.
 *
 * What this covers:
 * - Prepare a persisted parent session whose leaf ends inside an unfinished
 *   assistant/tool-use turn (user -> assistant toolUse -> toolResult)
 * - Derive a branch session using the same clean-turn selection logic used by
 *   teammate spawning
 * - Start a real worker process from that branched session in worktree mode
 *   context conditions (git repo + persisted session)
 * - Deliver an assigned task and verify the worker starts and completes it
 *
 * Usage:
 *   npx tsx scripts/integration-branch-context-test.mts
 *   npx tsx scripts/integration-branch-context-test.mts --timeoutSec 120
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { writeToMailbox } from "../extensions/teams/mailbox.js";
import { taskAssignmentPayload } from "../extensions/teams/protocol.js";
import { branchSelectionNote, resolveBranchLeafSelection } from "../extensions/teams/session-branching.js";
import { createTask, getTask } from "../extensions/teams/task-store.js";
import { ensureTeamConfig, loadTeamConfig } from "../extensions/teams/team-config.js";
import { sleep, terminateAll } from "./lib/pi-workers.js";

function parseArgs(argv: readonly string[]): { timeoutSec: number } {
	let timeoutSec = 120;
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--timeoutSec") {
			const v = argv[i + 1];
			if (v) timeoutSec = Number.parseInt(v, 10);
			i += 1;
		}
	}
	if (!Number.isFinite(timeoutSec) || timeoutSec < 30) timeoutSec = 120;
	return { timeoutSec };
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

async function waitFor(
	fn: () => boolean | Promise<boolean>,
	opts: { timeoutMs: number; pollMs: number; label: string },
): Promise<void> {
	const { timeoutMs, pollMs, label } = opts;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await sleep(pollMs);
	}
	throw new Error(`Timeout waiting for ${label}`);
}

function git(args: string[], cwd: string): void {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	}
}

async function latestMemberStatus(teamDir: string, name: string): Promise<{ status?: string; sessionFile?: string } | null> {
	const cfg = await loadTeamConfig(teamDir);
	if (!cfg) return null;
	const member = cfg.members.find((m) => m.name === name);
	if (!member) return null;
	return { status: member.status, sessionFile: member.sessionFile };
}

const { timeoutSec } = parseArgs(process.argv.slice(2));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-branch-context-"));
const teamsRootDir = path.join(tmpRoot, "teams-root");
const repoDir = path.join(tmpRoot, "repo");
const teamId = "branch-context-team";
const taskListId = teamId;
const teamDir = path.join(teamsRootDir, teamId);
const sessionsDir = path.join(teamDir, "sessions");
const agentName = "alpha";
const leadName = "team-lead";
const procs: ChildProcess[] = [];

try {
	fs.mkdirSync(repoDir, { recursive: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	git(["init", "-b", "main"], repoDir);
git(["config", "user.name", "Test User"], repoDir);
git(["config", "user.email", "test@example.com"], repoDir);
fs.writeFileSync(path.join(repoDir, "README.md"), "branch context integration\n", "utf8");
git(["add", "README.md"], repoDir);
git(["commit", "-m", "init"], repoDir);

const parent = SessionManager.create(repoDir, sessionsDir);
parent.appendModelChange("openai-codex", "gpt-5.4");
parent.appendThinkingLevelChange("minimal");
parent.appendMessage({
	role: "user",
	content: [{ type: "text", text: "Summarize the repo history." }],
	timestamp: Date.now(),
});
const stableAssistantId = parent.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "The repo history is summarized." }],
	api: "test",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});
const compactionId = parent.appendCompaction("summarized", stableAssistantId, 1234);
const currentUserId = parent.appendMessage({
	role: "user",
	content: [{ type: "text", text: "Investigate the repo, then delegate part of it." }],
	timestamp: Date.now(),
});
const toolUseAssistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
	api: "test",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};
parent.appendMessage(toolUseAssistant);
parent.appendMessage({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "branch context integration" }],
	isError: false,
	timestamp: Date.now(),
});

const parentLeafId = parent.getLeafId();
assert(parentLeafId !== null, "expected parent leaf id");
if (!parentLeafId) {
	throw new Error("Missing parent leaf id");
}

const selection = resolveBranchLeafSelection(parent.getBranch(parentLeafId), parentLeafId);
assert(selection.adjusted, "expected unfinished turn branch selection to adjust away from active leaf");
assert(selection.leafId === compactionId, `expected branch selection to use the stable pre-user boundary id, got ${selection.leafId}`);
assert(branchSelectionNote(selection) === "branch(clean-turn)", "expected clean-turn branch note");
assert(selection.replayUserMessage?.role === "user", "expected the active user request to be replayed into the cleaned child branch");

const branchedSessionFile = parent.createBranchedSession(selection.leafId);
assert(Boolean(branchedSessionFile), "expected branched session file to be created");
if (!branchedSessionFile) {
	throw new Error("Missing branched session file");
}
if (selection.replayUserMessage) {
	parent.appendMessage(JSON.parse(JSON.stringify(selection.replayUserMessage)) as Parameters<typeof parent.appendMessage>[0]);
}

const childEntries = parent.getEntries();
assert(childEntries.some((entry) => entry.id === stableAssistantId), "child session should retain the latest completed assistant message");
assert(childEntries.some((entry) => entry.id === compactionId), "child session should retain the compaction entry before the active user");
assert(!childEntries.some((entry) => entry.id === currentUserId), "child session should drop the original unfinished-turn user entry");
assert(
	childEntries.some(
		(entry) =>
			entry.type === "message" &&
			typeof entry.message === "object" &&
			entry.message !== null &&
			(entry.message as { role?: string }).role === "user" &&
			JSON.stringify((entry.message as { content?: unknown }).content).includes("Investigate the repo, then delegate part of it."),
	),
	"child session should replay the active user request onto the cleaned branch",
);
assert(
	!childEntries.some(
		(entry) =>
			entry.type === "message" &&
			typeof entry.message === "object" &&
			entry.message !== null &&
			(entry.message as { role?: string }).role === "assistant" &&
			entry.id !== stableAssistantId,
	),
	"child session should exclude the in-progress assistant tool-use message",
);
assert(
	!childEntries.some(
		(entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null && (entry.message as { role?: string }).role === "toolResult",
	),
	"child session should exclude trailing tool results from the unfinished turn",
);

await ensureTeamConfig(teamDir, { teamId, taskListId, leadName, style: "normal" });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");
assert(fs.existsSync(entryPath), `Missing teams entry path: ${entryPath}`);

const worker = spawn(
	"pi",
	[
		"--mode",
		"rpc",
		"--session",
		branchedSessionFile,
		"--session-dir",
		sessionsDir,
		"--provider",
		"openai-codex",
		"--model",
		"gpt-5.4",
		"--thinking",
		"minimal",
		"--no-extensions",
		"-e",
		entryPath,
		"--append-system-prompt",
		`You are teammate '${agentName}'. Prefer working from the shared task list.`,
	],
	{
		cwd: repoDir,
		env: {
			...process.env,
			PI_TEAMS_ROOT_DIR: teamsRootDir,
			PI_TEAMS_WORKER: "1",
			PI_TEAMS_TEAM_ID: teamId,
			PI_TEAMS_TASK_LIST_ID: taskListId,
			PI_TEAMS_AGENT_NAME: agentName,
			PI_TEAMS_LEAD_NAME: leadName,
			PI_TEAMS_STYLE: "normal",
			PI_TEAMS_AUTO_CLAIM: "0",
		},
		stdio: ["pipe", "pipe", "pipe"],
	},
);
procs.push(worker);

await waitFor(
	async () => {
		const member = await latestMemberStatus(teamDir, agentName);
		return member?.status === "online";
	},
	{ timeoutMs: timeoutSec * 1000, pollMs: 250, label: `${agentName} online` },
);

const task = await createTask(teamDir, taskListId, {
	subject: "Branch context integration",
	description: "Reply with exactly 'branch context integration ok'. Do not edit files.",
	owner: agentName,
});
await writeToMailbox(teamDir, taskListId, agentName, {
	from: leadName,
	text: JSON.stringify(taskAssignmentPayload(task, leadName)),
	timestamp: new Date().toISOString(),
});

await waitFor(
	async () => {
		const current = await getTask(teamDir, taskListId, task.id);
		const result = current?.metadata?.result;
		return current?.status === "completed" && typeof result === "string" && result.includes("branch context integration ok");
	},
	{ timeoutMs: timeoutSec * 1000, pollMs: 500, label: `task #${task.id} completion` },
);

	console.log("PASS: branch context integration test passed");
} finally {
	await terminateAll(procs);
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// ignore
	}
}
