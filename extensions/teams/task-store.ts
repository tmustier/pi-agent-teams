import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTask {
	id: string; // stringified integer (Claude-style)
	subject: string;
	description: string;
	owner?: string; // agent name
	status: TaskStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getTaskListDir(teamDir: string, taskListId: string): string {
	return path.join(teamDir, "tasks", sanitize(taskListId));
}

function taskPath(taskListDir: string, taskId: string): string {
	return path.join(taskListDir, `${sanitize(taskId)}.json`);
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

async function readJson(file: string): Promise<any | null> {
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function writeJsonAtomic(file: string, data: any): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, file);
}

function isStatus(s: any): s is TaskStatus {
	return s === "pending" || s === "in_progress" || s === "completed";
}

function coerceTask(obj: any): TeamTask | null {
	if (!obj || typeof obj !== "object") return null;
	if (typeof obj.id !== "string") return null;
	if (typeof obj.subject !== "string") return null;
	if (typeof obj.description !== "string") return null;
	if (!isStatus(obj.status)) return null;

	return {
		id: obj.id,
		subject: obj.subject,
		description: obj.description,
		owner: typeof obj.owner === "string" ? obj.owner : undefined,
		status: obj.status,
		blocks: Array.isArray(obj.blocks) ? obj.blocks.filter((x: any) => typeof x === "string") : [],
		blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.filter((x: any) => typeof x === "string") : [],
		metadata: obj.metadata && typeof obj.metadata === "object" ? obj.metadata : undefined,
		createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString(),
		updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
	};
}

async function allocateTaskId(taskListDir: string): Promise<string> {
	await ensureDir(taskListDir);

	const highwater = path.join(taskListDir, ".highwatermark");
	const lock = `${highwater}.lock`;

	return await withLock(
		lock,
		async () => {
			let n = 0;
			try {
				const raw = await fs.promises.readFile(highwater, "utf8");
				const parsed = Number.parseInt(raw.trim(), 10);
				if (Number.isFinite(parsed) && parsed > 0) n = parsed;
			} catch {
				// ignore
			}
			n += 1;
			await fs.promises.writeFile(highwater, `${n}\n`, "utf8");
			return String(n);
		},
		{ label: "tasks:allocate" },
	);
}

export function shortTaskId(id: string): string {
	return id;
}

export function formatTaskLine(t: TeamTask, opts: { blocked?: boolean } = {}): string {
	const blocked = Boolean(opts.blocked);
	const status = blocked && t.status === "pending" ? "blocked" : t.status;

	const deps = t.blockedBy?.length ?? 0;
	const blocks = t.blocks?.length ?? 0;

	const who = t.owner ? `@${t.owner}` : "";
	const head = `${t.id.padStart(3, " ")} ${status.padEnd(11)} ${who}`.trimEnd();

	const tags: string[] = [];
	if (blocked && t.status === "in_progress") tags.push("blocked");
	if (deps) tags.push(`deps:${deps}`);
	if (blocks) tags.push(`blocks:${blocks}`);
	const tagText = tags.length ? ` [${tags.join(" ")}]` : "";

	const preview = t.subject.length > 80 ? `${t.subject.slice(0, 80)}…` : t.subject;
	return `${head}${tagText}  ${preview}`;
}

export async function listTasks(teamDir: string, taskListId: string): Promise<TeamTask[]> {
	const dir = getTaskListDir(teamDir, taskListId);
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		const files = entries
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

		const out: TeamTask[] = [];
		for (const f of files) {
			const obj = await readJson(path.join(dir, f));
			const task = coerceTask(obj);
			if (task) out.push(task);
		}
		return out;
	} catch {
		return [];
	}
}

export async function getTask(teamDir: string, taskListId: string, taskId: string): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	const obj = await readJson(taskPath(dir, taskId));
	return coerceTask(obj);
}

export async function createTask(
	teamDir: string,
	taskListId: string,
	input: { subject: string; description: string; owner?: string },
): Promise<TeamTask> {
	const dir = getTaskListDir(teamDir, taskListId);
	const id = await allocateTaskId(dir);
	const now = new Date().toISOString();
	const task: TeamTask = {
		id,
		subject: input.subject,
		description: input.description,
		owner: input.owner,
		status: "pending",
		blocks: [],
		blockedBy: [],
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};

	await writeJsonAtomic(taskPath(dir, id), task);
	return task;
}

export async function updateTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	updater: (current: TeamTask) => TeamTask,
): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	const file = taskPath(dir, taskId);
	const lock = `${file}.lock`;

	await ensureDir(dir);

	return await withLock(
		lock,
		async () => {
			const curObj = await readJson(file);
			const cur = coerceTask(curObj);
			if (!cur) return null;
			const next = updater({ ...cur });
			next.updatedAt = new Date().toISOString();
			await writeJsonAtomic(file, next);
			return next;
		},
		{ label: `tasks:update:${taskId}` },
	);
}

export async function isTaskBlocked(teamDir: string, taskListId: string, task: TeamTask): Promise<boolean> {
	if (!task.blockedBy?.length) return false;
	for (const depId of task.blockedBy) {
		const dep = await getTask(teamDir, taskListId, depId);
		if (!dep) return true;
		if (dep.status !== "completed") return true;
	}
	return false;
}

export async function agentHasActiveTask(teamDir: string, taskListId: string, agentName: string): Promise<boolean> {
	const tasks = await listTasks(teamDir, taskListId);
	return tasks.some((t) => t.owner === agentName && t.status === "in_progress");
}

/**
 * Claim a specific task (owner must be empty).
 * Returns the updated task if claim succeeded, otherwise null.
 */
export async function claimTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		// Not claimable
		if (cur.status !== "pending") return cur;
		if (cur.owner) return cur;
		return {
			...cur,
			owner: agentName,
			status: "in_progress",
		};
	});
}

/**
 * Start an assigned task (owner matches), marking it in_progress.
 */
export async function startAssignedTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status !== "pending") return cur;
		return { ...cur, status: "in_progress" };
	});
}

export async function completeTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	result?: string,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;
		const metadata = { ...(cur.metadata ?? {}) };
		if (result) metadata.result = result;
		metadata.completedAt = new Date().toISOString();
		return { ...cur, status: "completed", metadata };
	});
}

export async function unassignTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	reason?: string,
	extraMetadata?: Record<string, unknown>,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;

		const metadata = { ...(cur.metadata ?? {}) };
		if (reason) metadata.unassignedReason = reason;
		metadata.unassignedAt = new Date().toISOString();
		if (extraMetadata) Object.assign(metadata, extraMetadata);

		return {
			...cur,
			owner: undefined,
			status: "pending",
			metadata,
		};
	});
}

/** Reset all non-completed tasks owned by agent back to pending + unowned. */
export async function unassignTasksForAgent(
	teamDir: string,
	taskListId: string,
	agentName: string,
	reason?: string,
): Promise<number> {
	const tasks = await listTasks(teamDir, taskListId);
	let changed = 0;
	for (const t of tasks) {
		if (t.owner !== agentName) continue;
		if (t.status === "completed") continue;
		const updated = await updateTask(teamDir, taskListId, t.id, (cur) => {
			const metadata = { ...(cur.metadata ?? {}) };
			if (reason) metadata.unassignedReason = reason;
			metadata.unassignedAt = new Date().toISOString();
			return {
				...cur,
				owner: undefined,
				status: "pending",
				metadata,
			};
		});
		if (updated) changed += 1;
	}
	return changed;
}

/**
 * Find and claim the first available task:
 * - pending
 * - unowned
 * - unblocked
 */
export async function claimNextAvailableTask(
	teamDir: string,
	taskListId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	const tasks = await listTasks(teamDir, taskListId);
	for (const t of tasks) {
		if (t.status !== "pending") continue;
		if (t.owner) continue;
		if (await isTaskBlocked(teamDir, taskListId, t)) continue;

		const claimed = await claimTask(teamDir, taskListId, t.id, agentName, { checkAgentBusy: false });
		if (claimed && claimed.owner === agentName && claimed.status === "in_progress") return claimed;
	}
	return null;
}

export type TaskDependencyOpResult =
	| { ok: true; task: TeamTask; dependency: TeamTask }
	| { ok: false; error: string };

function uniqStrings(xs: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const x of xs) {
		if (seen.has(x)) continue;
		seen.add(x);
		out.push(x);
	}
	return out;
}

/**
 * Add a dependency edge: taskId is blockedBy depId (and depId blocks taskId).
 */
export async function addTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	if (!taskId || !depId) return { ok: false, error: "Missing task id or dependency id" };
	if (taskId === depId) return { ok: false, error: "Task cannot depend on itself" };

	const task = await getTask(teamDir, taskListId, taskId);
	if (!task) return { ok: false, error: `Task not found: ${taskId}` };
	const dep = await getTask(teamDir, taskListId, depId);
	if (!dep) return { ok: false, error: `Dependency task not found: ${depId}` };

	const updatedTask = await updateTask(teamDir, taskListId, taskId, (cur) => ({
		...cur,
		blockedBy: uniqStrings([...(cur.blockedBy ?? []), depId]),
	}));
	if (!updatedTask) return { ok: false, error: `Task not found: ${taskId}` };

	const updatedDep = await updateTask(teamDir, taskListId, depId, (cur) => ({
		...cur,
		blocks: uniqStrings([...(cur.blocks ?? []), taskId]),
	}));
	if (!updatedDep) return { ok: false, error: `Dependency task not found: ${depId}` };

	return { ok: true, task: updatedTask, dependency: updatedDep };
}

/**
 * Remove dependency edge: taskId no longer blockedBy depId (and depId no longer blocks taskId).
 */
export async function removeTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	if (!taskId || !depId) return { ok: false, error: "Missing task id or dependency id" };
	if (taskId === depId) return { ok: false, error: "Task cannot remove itself as a dependency" };

	const task = await getTask(teamDir, taskListId, taskId);
	if (!task) return { ok: false, error: `Task not found: ${taskId}` };
	const dep = await getTask(teamDir, taskListId, depId);
	if (!dep) return { ok: false, error: `Dependency task not found: ${depId}` };

	const updatedTask = await updateTask(teamDir, taskListId, taskId, (cur) => ({
		...cur,
		blockedBy: (cur.blockedBy ?? []).filter((x) => x !== depId),
	}));
	if (!updatedTask) return { ok: false, error: `Task not found: ${taskId}` };

	const updatedDep = await updateTask(teamDir, taskListId, depId, (cur) => ({
		...cur,
		blocks: (cur.blocks ?? []).filter((x) => x !== taskId),
	}));
	if (!updatedDep) return { ok: false, error: `Dependency task not found: ${depId}` };

	return { ok: true, task: updatedTask, dependency: updatedDep };
}

export type TaskClearMode = "completed" | "all";

export interface ClearTasksResult {
	mode: TaskClearMode;
	taskListId: string;
	taskListDir: string;
	deletedTaskIds: string[];
	skippedTaskIds: string[];
	errors: Array<{ file: string; error: string }>;
}

/**
 * Delete task JSON files from the task list directory.
 *
 * Safety properties:
 * - Only deletes `*.json` files inside `<teamDir>/tasks/<taskListId>/`.
 * - Refuses to operate if the resolved task list directory is not within `teamDir`.
 */
export async function clearTasks(
	teamDir: string,
	taskListId: string,
	mode: TaskClearMode = "completed",
): Promise<ClearTasksResult> {
	const taskListDir = getTaskListDir(teamDir, taskListId);

	// Path safety: ensure the taskListDir is inside teamDir (prevents path traversal accidents).
	const teamAbs = path.resolve(teamDir);
	const listAbs = path.resolve(taskListDir);
	if (!(listAbs === teamAbs || listAbs.startsWith(teamAbs + path.sep))) {
		throw new Error(`Refusing to clear tasks outside teamDir. teamDir=${teamAbs} taskListDir=${listAbs}`);
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(taskListDir, { withFileTypes: true });
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			return { mode, taskListId, taskListDir, deletedTaskIds: [], skippedTaskIds: [], errors: [] };
		}
		throw err;
	}

	const deletedTaskIds: string[] = [];
	const skippedTaskIds: string[] = [];
	const errors: Array<{ file: string; error: string }> = [];

	for (const e of entries) {
		if (!e.isFile()) continue;
		if (!e.name.endsWith(".json")) continue;

		const file = path.join(taskListDir, e.name);
		const fileAbs = path.resolve(file);
		if (!fileAbs.startsWith(listAbs + path.sep)) {
			errors.push({ file, error: "Refusing to delete file outside taskListDir" });
			continue;
		}

		let shouldDelete = false;
		let taskIdFromName = e.name.slice(0, -".json".length);

		if (mode === "all") {
			shouldDelete = true;
		} else {
			const obj = await readJson(file);
			const task = coerceTask(obj);
			if (task && task.status === "completed") {
				shouldDelete = true;
				taskIdFromName = task.id;
			}
		}

		if (!shouldDelete) {
			skippedTaskIds.push(taskIdFromName);
			continue;
		}

		try {
			await fs.promises.unlink(file);
			deletedTaskIds.push(taskIdFromName);
		} catch (err: any) {
			if (err?.code === "ENOENT") continue;
			errors.push({ file, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return { mode, taskListId, taskListDir, deletedTaskIds, skippedTaskIds, errors };
}
