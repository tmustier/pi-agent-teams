import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";

export interface TeamMember {
	name: string;
	role: "lead" | "worker";
	addedAt: string;
	status: "online" | "offline";
	lastSeenAt?: string;
	/** Optional: teammate session file path (useful for debugging) */
	sessionFile?: string;
	/** Optional: teammate working directory */
	cwd?: string;
	/** Freeform metadata for future use */
	meta?: Record<string, unknown>;
}

export interface TeamConfig {
	version: 1;
	teamId: string;
	/** Task list namespace identifier (Claude-style: often teamName or parentSessionId) */
	taskListId: string;
	leadName: string;
	createdAt: string;
	updatedAt: string;
	members: TeamMember[];
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getTeamConfigPath(teamDir: string): string {
	return path.join(teamDir, "config.json");
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

function coerceMember(obj: any): TeamMember | null {
	if (!obj || typeof obj !== "object") return null;
	if (typeof obj.name !== "string") return null;
	if (obj.role !== "lead" && obj.role !== "worker") return null;
	if (obj.status !== "online" && obj.status !== "offline") return null;
	if (typeof obj.addedAt !== "string") return null;

	return {
		name: sanitize(obj.name),
		role: obj.role,
		status: obj.status,
		addedAt: obj.addedAt,
		lastSeenAt: typeof obj.lastSeenAt === "string" ? obj.lastSeenAt : undefined,
		sessionFile: typeof obj.sessionFile === "string" ? obj.sessionFile : undefined,
		cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
		meta: obj.meta && typeof obj.meta === "object" ? obj.meta : undefined,
	};
}

function coerceConfig(obj: any): TeamConfig | null {
	if (!obj || typeof obj !== "object") return null;
	if (obj.version !== 1) return null;
	if (typeof obj.teamId !== "string") return null;
	if (typeof obj.taskListId !== "string") return null;
	if (typeof obj.leadName !== "string") return null;
	if (typeof obj.createdAt !== "string") return null;
	if (typeof obj.updatedAt !== "string") return null;
	if (!Array.isArray(obj.members)) return null;

	const members = obj.members.map(coerceMember).filter(Boolean) as TeamMember[];
	return {
		version: 1,
		teamId: obj.teamId,
		taskListId: obj.taskListId,
		leadName: sanitize(obj.leadName),
		createdAt: obj.createdAt,
		updatedAt: obj.updatedAt,
		members,
	};
}

export async function loadTeamConfig(teamDir: string): Promise<TeamConfig | null> {
	const file = getTeamConfigPath(teamDir);
	const obj = await readJson(file);
	return coerceConfig(obj);
}

export async function ensureTeamConfig(teamDir: string, init: { teamId: string; taskListId: string; leadName: string }): Promise<TeamConfig> {
	const file = getTeamConfigPath(teamDir);
	const lock = `${file}.lock`;

	await ensureDir(teamDir);

	return await withLock(
		lock,
		async () => {
			const existing = coerceConfig(await readJson(file));
			if (existing) return existing;

			const now = new Date().toISOString();
			const cfg: TeamConfig = {
				version: 1,
				teamId: init.teamId,
				taskListId: init.taskListId,
				leadName: sanitize(init.leadName),
				createdAt: now,
				updatedAt: now,
				members: [
					{
						name: sanitize(init.leadName),
						role: "lead",
						addedAt: now,
						status: "online",
						lastSeenAt: now,
					},
				],
			};

			await writeJsonAtomic(file, cfg);
			return cfg;
		},
		{ label: "team-config:ensure" },
	);
}

export async function upsertMember(
	teamDir: string,
	member: Omit<TeamMember, "name" | "addedAt"> & { name: string; addedAt?: string },
): Promise<TeamConfig> {
	const file = getTeamConfigPath(teamDir);
	const lock = `${file}.lock`;

	await ensureDir(teamDir);

	return await withLock(
		lock,
		async () => {
			const existing = coerceConfig(await readJson(file));
			if (!existing) {
				throw new Error(`Team config missing. Call ensureTeamConfig() first. path=${file}`);
			}

			const now = new Date().toISOString();
			const name = sanitize(member.name);
			const idx = existing.members.findIndex((m) => m.name === name);

			const nextMember: TeamMember = {
				name,
				role: member.role,
				status: member.status,
				addedAt: idx >= 0 ? existing.members[idx].addedAt : member.addedAt ?? now,
				lastSeenAt: member.lastSeenAt ?? now,
				sessionFile: member.sessionFile,
				cwd: member.cwd,
				meta: member.meta,
			};

			const members = existing.members.slice();
			if (idx >= 0) members[idx] = { ...members[idx], ...nextMember, addedAt: members[idx].addedAt };
			else members.push(nextMember);

			const updated: TeamConfig = {
				...existing,
				updatedAt: now,
				members,
			};

			await writeJsonAtomic(file, updated);
			return updated;
		},
		{ label: `team-config:upsert:${member.name}` },
	);
}

export async function setMemberStatus(
	teamDir: string,
	memberName: string,
	status: "online" | "offline",
	extra?: { lastSeenAt?: string; meta?: Record<string, unknown> },
): Promise<TeamConfig | null> {
	const file = getTeamConfigPath(teamDir);
	const lock = `${file}.lock`;

	await ensureDir(teamDir);

	return await withLock(
		lock,
		async () => {
			const existing = coerceConfig(await readJson(file));
			if (!existing) return null;

			const name = sanitize(memberName);
			const idx = existing.members.findIndex((m) => m.name === name);
			if (idx < 0) return existing;

			const now = new Date().toISOString();
			const members = existing.members.slice();
			members[idx] = {
				...members[idx],
				status,
				lastSeenAt: extra?.lastSeenAt ?? now,
				meta: extra?.meta ? { ...(members[idx].meta ?? {}), ...extra.meta } : members[idx].meta,
			};

			const updated: TeamConfig = { ...existing, updatedAt: now, members };
			await writeJsonAtomic(file, updated);
			return updated;
		},
		{ label: `team-config:status:${memberName}` },
	);
}
