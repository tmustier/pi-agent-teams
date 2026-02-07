import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface TeamTask {
	id: string;
	text: string;
	status: TaskStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	assignee?: string;
	result?: string;
	error?: string;
}

export function shortId(id: string): string {
	return id.slice(0, 8);
}

export function countTasks(tasks: TeamTask[]): Record<TaskStatus, number> {
	return tasks.reduce(
		(acc, t) => {
			acc[t.status] = (acc[t.status] ?? 0) + 1;
			return acc;
		},
		{ queued: 0, running: 0, done: 0, failed: 0 } as Record<TaskStatus, number>,
	);
}

export function parseAssigneePrefix(text: string): { assignee?: string; text: string } {
	const m = text.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
	if (!m) return { text };
	return { assignee: m[1], text: m[2] };
}

export function createTask(text: string, assignee?: string): TeamTask {
	return {
		id: randomUUID(),
		text,
		status: "queued",
		createdAt: new Date().toISOString(),
		assignee,
	};
}

export async function loadTasks(tasksFile: string): Promise<TeamTask[]> {
	try {
		const raw = await fs.promises.readFile(tasksFile, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];

		const isStatus = (s: any): s is TaskStatus => s === "queued" || s === "running" || s === "done" || s === "failed";

		return parsed
			.filter((t) => t && typeof t === "object" && typeof t.id === "string" && typeof t.text === "string")
			.map((t: any) => {
				const status: TaskStatus = isStatus(t.status) ? t.status : "queued";
				const task: TeamTask = {
					id: t.id,
					text: t.text,
					status,
					createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString(),
					startedAt: typeof t.startedAt === "string" ? t.startedAt : undefined,
					finishedAt: typeof t.finishedAt === "string" ? t.finishedAt : undefined,
					assignee: typeof t.assignee === "string" ? t.assignee : undefined,
					result: typeof t.result === "string" ? t.result : undefined,
					error: typeof t.error === "string" ? t.error : undefined,
				};
				return task;
			});
	} catch {
		return [];
	}
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

export async function saveTasks(tasksFile: string, tasks: TeamTask[]): Promise<void> {
	await ensureDir(path.dirname(tasksFile));
	const tmp = `${tasksFile}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(tasks, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, tasksFile);
}

export function formatTaskLine(t: TeamTask): string {
	const who = t.assignee ? `@${t.assignee}` : "";
	const head = `${shortId(t.id)} ${t.status.padEnd(7)} ${who}`.trimEnd();
	const preview = t.text.length > 80 ? `${t.text.slice(0, 80)}…` : t.text;
	return `${head}  ${preview}`;
}
