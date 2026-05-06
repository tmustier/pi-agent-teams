import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateAll(children: readonly ChildProcess[]): Promise<void> {
	for (const c of children) {
		if (hasExited(c)) continue;
		try {
			c.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

	// Give them a moment to flush + exit.
	const deadline = Date.now() + 10_000;
	for (const c of children) {
		while (!hasExited(c) && Date.now() < deadline) {
			await sleep(100);
		}
		if (!hasExited(c)) {
			try {
				c.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	}
}

export function spawnTeamsWorkerRpc(opts: {
	cwd: string;
	entryPath: string;
	sessionsDir: string;
	teamId: string;
	taskListId: string;
	agentName: string;
	leadName: string;
	style: string;
	autoClaim: boolean;
	planRequired: boolean;
	systemAppend: string;
	logDir: string;
	extraEnv?: Record<string, string>;
}): ChildProcess {
	const {
		cwd,
		entryPath,
		sessionsDir,
		teamId,
		taskListId,
		agentName,
		leadName,
		style,
		autoClaim,
		planRequired,
		systemAppend,
		logDir,
		extraEnv,
	} = opts;

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
		systemAppend,
	];

	return spawn("pi", args, {
		cwd,
		env: {
			...process.env,
			PI_TEAMS_WORKER: "1",
			PI_TEAMS_TEAM_ID: teamId,
			PI_TEAMS_TASK_LIST_ID: taskListId,
			PI_TEAMS_AGENT_NAME: agentName,
			PI_TEAMS_LEAD_NAME: leadName,
			PI_TEAMS_STYLE: style,
			PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0",
			PI_TEAMS_PLAN_REQUIRED: planRequired ? "1" : "0",
			...(extraEnv ?? {}),
		},
		stdio: ["ignore", out, err],
	});
}
