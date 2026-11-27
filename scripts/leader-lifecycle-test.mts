/** Exercise leader polling across real Pi runtime replacement, without a model call. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAgentSessionFromServices,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { getTaskListDir } from "../extensions/teams/task-store.js";
import { ensureTeamConfig } from "../extensions/teams/team-config.js";
import { getTeamDir } from "../extensions/teams/paths.js";
import { getInboxPath, writeToMailbox } from "../extensions/teams/mailbox.js";
import { TEAM_MAILBOX_NS } from "../extensions/teams/protocol.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-lifecycle-"));
const previousRoot = process.env.PI_TEAMS_ROOT_DIR;
process.env.PI_TEAMS_ROOT_DIR = path.join(root, "teams");
const unhandled: unknown[] = [];
const errors: string[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("unhandledRejection", onUnhandled);

const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		resourceLoaderOptions: {
			noExtensions: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../extensions/teams/index.ts", import.meta.url))],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
	});
	const result = await createAgentSessionFromServices({
		services,
		sessionManager: options.sessionManager,
		sessionStartEvent: options.sessionStartEvent,
		noTools: "all",
	});
	assert.equal(result.extensionsResult.errors.length, 0, "extension loads in real Pi");
	return { ...result, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: root,
	agentDir: path.join(root, "agent"),
	sessionManager: SessionManager.create(root, path.join(root, "sessions")),
});
const bind = (session: AgentSession) => session.bindExtensions({
	onError: (event) => { errors.push(event.error); },
});
runtime.setRebindSession(bind);
await bind(runtime.session);
assert(runtime.session.extensionRunner.getRegisteredCommands().some((c) => c.name === "team"), "teams extension registered");

// Hold a real refresh's disk read until after Pi invalidates its runner. The
// shutdown clears future intervals, but cannot cancel this already-running tick.
const originalReaddir = fs.promises.readdir;
const originalMkdir = fs.promises.mkdir;
const originalReadFile = fs.promises.readFile;
let releaseRead = () => {};
try {
	for (let round = 0; round < 3; round++) {
		const oldId = runtime.session.sessionId;
		const taskDir = getTaskListDir(getTeamDir(oldId), oldId);
		let markBlocked = () => {};
		const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
		const released = new Promise<void>((resolve) => { releaseRead = resolve; });
		let armed = true;
		fs.promises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
			if (armed && String(args[0]) === taskDir) {
				armed = false;
				markBlocked();
				await released;
			}
			return originalReaddir(...args);
		}) as typeof originalReaddir;
		await Promise.race([
			blocked,
			sleep(5_000).then(() => { throw new Error("leader refresh never reached task read"); }),
		]);
		await runtime.newSession();
		assert.notEqual(runtime.session.sessionId, oldId, "real Pi replaced session");
		releaseRead();
		fs.promises.readdir = originalReaddir;
		await sleep(100);
		assert.deepEqual(unhandled, [], "in-flight leader refresh must not reject after invalidation");
		assert.deepEqual(errors, [], "session replacement must not report extension errors");
		console.log(`PASS: real Pi session replacement with in-flight leader refresh (round ${round + 1})`);
	}

	const inboxTeamDir = getTeamDir(runtime.session.sessionId);
	await writeToMailbox(inboxTeamDir, TEAM_MAILBOX_NS, "team-lead", {
		from: "worker", text: "in-flight inbox sentinel", timestamp: new Date().toISOString(),
	});
	let markInboxBlocked = () => {};
	const inboxBlocked = new Promise<void>((resolve) => { markInboxBlocked = resolve; });
	const inboxReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
	let inboxArmed = true;
	fs.promises.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
		const result = await originalReadFile(...args);
		if (inboxArmed && String(args[0]) === getInboxPath(inboxTeamDir, TEAM_MAILBOX_NS, "team-lead")) {
			inboxArmed = false;
			markInboxBlocked();
			await inboxReleased;
		}
		return result;
	}) as typeof originalReadFile;
	await Promise.race([
		inboxBlocked,
		sleep(5_000).then(() => { throw new Error("leader inbox never reached mailbox read"); }),
	]);
	await runtime.newSession();
	releaseRead();
	fs.promises.readFile = originalReadFile;
	await sleep(100);
	assert.deepEqual(unhandled, [], "in-flight inbox must not reject after invalidation");
	console.log("PASS: real Pi session replacement with in-flight leader inbox");

	// A live-session polling error must also be observed, and a failing error UI
	// must not turn the catch handler into another unhandled rejection.
	const ui = runtime.session.extensionRunner.createContext().ui;
	const originalWidget = ui.setWidget;
	const originalNotify = ui.notify;
	let attemptedWidget = false;
	let attemptedWarning = false;
	ui.setWidget = () => { attemptedWidget = true; throw new Error("simulated widget failure"); };
	ui.notify = () => { attemptedWarning = true; throw new Error("simulated unavailable UI"); };
	try {
		await sleep(1_200);
		assert(attemptedWidget && attemptedWarning, "refresh failure reached safe error reporting");
		assert.deepEqual(unhandled, [], "polling error reporting cannot reject");
	} finally {
		ui.setWidget = originalWidget;
		ui.notify = originalNotify;
	}
	console.log("PASS: live polling failure and failing notification UI remain contained");

	// Fail attach-claim cleanup before it reaches its lock. Pi must still finish
	// shutdown, invalidate the old runner, and start healthy replacement loops.
	const attachedDir = getTeamDir("attached");
	await ensureTeamConfig(attachedDir, { teamId: "attached", taskListId: "attached", leadName: "team-lead", style: "normal" });
	const command = runtime.session.extensionRunner.getRegisteredCommands().find((c) => c.name === "team");
	assert(command);
	await command.handler("attach attached", runtime.session.extensionRunner.createCommandContext());
	let failedRelease = false;
	fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
		if (String(args[0]) === attachedDir) {
			failedRelease = true;
			throw Object.assign(new Error("simulated claim release failure"), { code: "EACCES" });
		}
		return originalMkdir(...args);
	}) as typeof originalMkdir;
	await runtime.newSession();
	fs.promises.mkdir = originalMkdir;
	assert(failedRelease, "shutdown exercised a failing claim release");
	await sleep(1_200);
	assert.deepEqual(errors, [], "claim cleanup failure must not abort shutdown");
	assert.deepEqual(unhandled, [], "old polling must not survive failed claim cleanup");
	console.log("PASS: real Pi session replacement survives failed attach-claim cleanup");
} finally {
	releaseRead();
	fs.promises.readdir = originalReaddir;
	fs.promises.mkdir = originalMkdir;
	fs.promises.readFile = originalReadFile;
	await runtime.dispose();
	process.off("unhandledRejection", onUnhandled);
	if (previousRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = previousRoot;
	fs.rmSync(root, { recursive: true, force: true });
}
