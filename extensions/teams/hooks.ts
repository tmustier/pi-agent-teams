import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getTeamsHooksDir } from "./paths.js";
import type { TeamTask } from "./task-store.js";

/**
 * Hook contract version. Increment on breaking changes only.
 * See docs/hook-contract.md for the full compatibility policy.
 */
export const HOOK_CONTRACT_VERSION = 1;

export type TeamsHookEvent = "idle" | "task_completed" | "task_failed";

export type TeamsHookInvocation = {
	event: TeamsHookEvent;
	teamId: string;
	teamDir: string;
	taskListId: string;
	style: string;
	memberName?: string;
	timestamp?: string;
	completedTask?: TeamTask | null;
};

/**
 * Structured context payload passed to hooks via PI_TEAMS_HOOK_CONTEXT_JSON.
 *
 * `task` is null for "idle" events and may also be null for task_completed /
 * task_failed events when the task was cleared before the leader processed the
 * worker's idle notification (race condition). Hook authors must guard access.
 *
 * For task_failed events, `task.status` is typically "pending" — the worker
 * resets the task status before emitting the idle notification.
 *
 * See docs/hook-contract.md for the full schema and compatibility policy.
 */
export interface HookContextPayload {
	version: typeof HOOK_CONTRACT_VERSION;
	event: TeamsHookEvent;
	team: {
		id: string;
		dir: string;
		taskListId: string;
		style: string;
	};
	member: string | null;
	timestamp: string | null;
	task: {
		id: string;
		subject: string;
		description: string;
		owner: string | null;
		status: string;
		blockedBy: string[];
		blocks: string[];
		metadata: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
	} | null;
}

export type TeamsHookRunResult = {
	ran: boolean;
	hookPath?: string;
	command?: readonly string[];
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	error?: string;
	/** The contract version used for this invocation. */
	contractVersion: typeof HOOK_CONTRACT_VERSION;
};

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function isExecutable(st: fs.Stats): boolean {
	// Owner/group/other execute bit.
	return (st.mode & 0o111) !== 0;
}

function trimOutput(s: string, limit = 12_000): string {
	if (s.length <= limit) return s;
	return s.slice(0, limit) + `\n… (truncated, ${s.length - limit} bytes omitted)`;
}

function parseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_TEAMS_HOOK_TIMEOUT_MS;
	if (!raw) return 60_000;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export function areTeamsHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_TEAMS_HOOKS_ENABLED === "1";
}

export type TeamsHookFailureAction = "warn" | "followup" | "reopen" | "reopen_followup";
export type TeamsHookFollowupOwnerPolicy = "member" | "lead" | "none";

export function isTeamsHookFailureAction(value: string): value is TeamsHookFailureAction {
	return value === "warn" || value === "followup" || value === "reopen" || value === "reopen_followup";
}

export function getTeamsHookFailureAction(
	env: NodeJS.ProcessEnv = process.env,
	override?: string,
): TeamsHookFailureAction {
	const explicit = override?.trim().toLowerCase();
	if (explicit && isTeamsHookFailureAction(explicit)) return explicit;
	const raw = env.PI_TEAMS_HOOKS_FAILURE_ACTION?.trim().toLowerCase();
	if (raw && isTeamsHookFailureAction(raw)) return raw;
	if (env.PI_TEAMS_HOOKS_CREATE_TASK_ON_FAILURE === "1") return "followup";
	return "warn";
}

export function shouldCreateHookFollowupTask(action: TeamsHookFailureAction): boolean {
	return action === "followup" || action === "reopen_followup";
}

export function shouldReopenTaskOnHookFailure(action: TeamsHookFailureAction): boolean {
	return action === "reopen" || action === "reopen_followup";
}

export function isTeamsHookFollowupOwnerPolicy(value: string): value is TeamsHookFollowupOwnerPolicy {
	return value === "member" || value === "lead" || value === "none";
}

export function getTeamsHookFollowupOwnerPolicy(
	env: NodeJS.ProcessEnv = process.env,
	override?: string,
): TeamsHookFollowupOwnerPolicy {
	const explicit = override?.trim().toLowerCase();
	if (explicit && isTeamsHookFollowupOwnerPolicy(explicit)) return explicit;
	const raw = env.PI_TEAMS_HOOKS_FOLLOWUP_OWNER?.trim().toLowerCase();
	if (raw && isTeamsHookFollowupOwnerPolicy(raw)) return raw;
	return "member";
}

export function resolveTeamsHookFollowupOwner(opts: {
	policy: TeamsHookFollowupOwnerPolicy;
	memberName?: string;
	leadName?: string;
}): string | undefined {
	if (opts.policy === "none") return undefined;
	if (opts.policy === "lead") {
		const lead = opts.leadName?.trim();
		return lead ? lead : undefined;
	}
	const member = opts.memberName?.trim();
	if (member) return member;
	const lead = opts.leadName?.trim();
	return lead ? lead : undefined;
}

export function getTeamsHookMaxReopensPerTask(env: NodeJS.ProcessEnv = process.env, override?: number): number {
	if (typeof override === "number" && Number.isFinite(override) && override >= 0) return Math.floor(override);
	const raw = env.PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK?.trim();
	if (!raw) return 3;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 3;
	return parsed;
}

function truncateField(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function buildHookContextPayload(invocation: TeamsHookInvocation): HookContextPayload {
	const task = invocation.completedTask;
	return {
		version: HOOK_CONTRACT_VERSION,
		event: invocation.event,
		team: {
			id: invocation.teamId,
			dir: invocation.teamDir,
			taskListId: invocation.taskListId,
			style: invocation.style,
		},
		member: invocation.memberName ?? null,
		timestamp: invocation.timestamp ?? null,
		task: task
			? {
				id: task.id,
				subject: truncateField(task.subject, 1_000),
				description: truncateField(task.description, 8_000),
				owner: task.owner ?? null,
				status: task.status,
				blockedBy: task.blockedBy.slice(0, 200),
				blocks: task.blocks.slice(0, 200),
				metadata: task.metadata ?? {},
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
			}
			: null,
	};
}

function getHookContextJson(invocation: TeamsHookInvocation): string {
	return JSON.stringify(buildHookContextPayload(invocation));
}

export function getHookBaseName(event: TeamsHookEvent): string {
	switch (event) {
		case "idle":
			return "on_idle";
		case "task_completed":
			return "on_task_completed";
		case "task_failed":
			return "on_task_failed";
	}
}

type HookCommand = { cmd: string; args: string[]; hookPath: string; display: readonly string[] };

function resolveHookCommand(hooksDir: string, event: TeamsHookEvent): HookCommand | null {
	const base = getHookBaseName(event);
	const candidates = [
		path.join(hooksDir, base),
		path.join(hooksDir, `${base}.sh`),
		path.join(hooksDir, `${base}.js`),
		path.join(hooksDir, `${base}.mjs`),
	];

	for (const file of candidates) {
		try {
			if (!fs.existsSync(file)) continue;
			const st = fs.statSync(file);
			if (!st.isFile()) continue;

			const ext = path.extname(file).toLowerCase();
			if (ext === ".js" || ext === ".mjs") {
				return { cmd: "node", args: [file], hookPath: file, display: ["node", file] };
			}

			if (ext === ".sh") {
				return { cmd: "bash", args: [file], hookPath: file, display: ["bash", file] };
			}

			if (isExecutable(st)) {
				return { cmd: file, args: [], hookPath: file, display: [file] };
			}

			// Non-executable with unknown extension: ignore.
		} catch {
			// ignore
		}
	}

	return null;
}

async function runWithTimeout(opts: {
	cmd: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
}): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; error?: string }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const child = spawn(opts.cmd, [...opts.args], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore
			}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, 1000);
		}, opts.timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({
				exitCode: code,
				timedOut,
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr),
			});
		});

		child.on("error", (err: unknown) => {
			clearTimeout(timeout);
			const msg = err instanceof Error ? err.message : String(err);
			resolve({ exitCode: null, timedOut: false, stdout: trimOutput(stdout), stderr: trimOutput(stderr), error: msg });
		});
	});
}

export async function runTeamsHook(opts: {
	invocation: TeamsHookInvocation;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<TeamsHookRunResult> {
	const env = opts.env ?? process.env;
	if (!areTeamsHooksEnabled(env)) {
		return {
			ran: false,
			exitCode: null,
			timedOut: false,
			durationMs: 0,
			stdout: "",
			stderr: "",
			contractVersion: HOOK_CONTRACT_VERSION,
		};
	}

	const hooksDir = getTeamsHooksDir();
	const hook = resolveHookCommand(hooksDir, opts.invocation.event);
	if (!hook) {
		return {
			ran: false,
			exitCode: null,
			timedOut: false,
			durationMs: 0,
			stdout: "",
			stderr: "",
			contractVersion: HOOK_CONTRACT_VERSION,
		};
	}

	const timeoutMs = parseTimeoutMs(env);
	const start = Date.now();

	const baseEnv: NodeJS.ProcessEnv = {
		...env,
		PI_TEAMS_HOOK_EVENT: opts.invocation.event,
		PI_TEAMS_HOOK_CONTEXT_VERSION: String(HOOK_CONTRACT_VERSION),
		PI_TEAMS_HOOK_CONTEXT_JSON: getHookContextJson(opts.invocation),
		PI_TEAMS_TEAM_ID: opts.invocation.teamId,
		PI_TEAMS_TEAM_DIR: opts.invocation.teamDir,
		PI_TEAMS_TASK_LIST_ID: opts.invocation.taskListId,
		PI_TEAMS_STYLE: opts.invocation.style,
		...(opts.invocation.memberName ? { PI_TEAMS_MEMBER: opts.invocation.memberName } : {}),
		...(opts.invocation.timestamp ? { PI_TEAMS_EVENT_TIMESTAMP: opts.invocation.timestamp } : {}),
	};

	const t = opts.invocation.completedTask;
	const envWithTask: NodeJS.ProcessEnv = {
		...baseEnv,
		...(t?.id ? { PI_TEAMS_TASK_ID: t.id } : {}),
		...(t?.subject ? { PI_TEAMS_TASK_SUBJECT: t.subject } : {}),
		...(t?.owner ? { PI_TEAMS_TASK_OWNER: t.owner } : {}),
		...(t?.status ? { PI_TEAMS_TASK_STATUS: t.status } : {}),
	};

	let res;
	try {
		res = await runWithTimeout({ cmd: hook.cmd, args: hook.args, cwd: opts.cwd, env: envWithTask, timeoutMs });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ran: true,
			hookPath: hook.hookPath,
			command: hook.display,
			exitCode: null,
			timedOut: false,
			durationMs: Date.now() - start,
			stdout: "",
			stderr: "",
			error: msg,
			contractVersion: HOOK_CONTRACT_VERSION,
		};
	}

	return {
		ran: true,
		hookPath: hook.hookPath,
		command: hook.display,
		exitCode: res.exitCode,
		timedOut: res.timedOut,
		durationMs: Date.now() - start,
		stdout: res.stdout,
		stderr: res.stderr,
		error: res.error,
		contractVersion: HOOK_CONTRACT_VERSION,
	};
}

export async function ensureHooksDirExists(): Promise<void> {
	const dir = getTeamsHooksDir();
	try {
		await fs.promises.mkdir(dir, { recursive: true });
	} catch (err) {
		// ignore permission errors; caller can surface if needed
		if (isErrnoException(err) && err.code === "EACCES") return;
	}
}
