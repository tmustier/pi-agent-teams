import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";
import type { TeamsStyle } from "./teams-style.js";
import { normalizeTeamsStyleId } from "./teams-style.js";

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

export type TeamHooksFailureAction = "warn" | "followup" | "reopen" | "reopen_followup";
export type TeamHooksFollowupOwnerPolicy = "member" | "lead" | "none";

export interface TeamHooksPolicy {
	failureAction?: TeamHooksFailureAction;
	maxReopensPerTask?: number;
	followupOwner?: TeamHooksFollowupOwnerPolicy;
}

export interface TeamConfig {
	version: 1;
	teamId: string;
	/** Task list namespace identifier (Claude-style: often teamName or parentSessionId) */
	taskListId: string;
	/** Internal leader agent id (mailbox name, member name, etc.) */
	leadName: string;
	/** Optional UI/UX style. If omitted, treat as "normal". */
	style?: TeamsStyle;
	/** Optional per-team hooks policy override (env remains fallback). */
	hooks?: TeamHooksPolicy;
	createdAt: string;
	updatedAt: string;
	members: TeamMember[];
}

export function getTeamConfigPath(teamDir: string): string {
	return path.join(teamDir, "config.json");
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function coerceStyle(v: unknown): TeamsStyle | undefined {
	return normalizeTeamsStyleId(v) ?? undefined;
}

function isTeamHooksFailureAction(v: unknown): v is TeamHooksFailureAction {
	return v === "warn" || v === "followup" || v === "reopen" || v === "reopen_followup";
}

function isTeamHooksFollowupOwnerPolicy(v: unknown): v is TeamHooksFollowupOwnerPolicy {
	return v === "member" || v === "lead" || v === "none";
}

function coerceNonNegativeInt(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
	return Math.floor(v);
}

function coerceHooksPolicy(v: unknown): TeamHooksPolicy | undefined {
	if (!isRecord(v)) return undefined;
	const failureAction = isTeamHooksFailureAction(v.failureAction) ? v.failureAction : undefined;
	const maxReopensPerTask = coerceNonNegativeInt(v.maxReopensPerTask);
	const followupOwner = isTeamHooksFollowupOwnerPolicy(v.followupOwner) ? v.followupOwner : undefined;
	if (!failureAction && maxReopensPerTask === undefined && !followupOwner) return undefined;
	return { failureAction, maxReopensPerTask, followupOwner };
}

async function readJson(file: string): Promise<unknown | null> {
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return parsed;
	} catch {
		return null;
	}
}

function coerceMember(obj: unknown): TeamMember | null {
	if (!isRecord(obj)) return null;
	if (typeof obj.name !== "string") return null;
	if (obj.role !== "lead" && obj.role !== "worker") return null;
	if (obj.status !== "online" && obj.status !== "offline") return null;
	if (typeof obj.addedAt !== "string") return null;

	return {
		name: sanitizeName(obj.name),
		role: obj.role,
		status: obj.status,
		addedAt: obj.addedAt,
		lastSeenAt: typeof obj.lastSeenAt === "string" ? obj.lastSeenAt : undefined,
		sessionFile: typeof obj.sessionFile === "string" ? obj.sessionFile : undefined,
		cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
		meta: isRecord(obj.meta) ? obj.meta : undefined,
	};
}

function coerceConfig(obj: unknown): TeamConfig | null {
	if (!isRecord(obj)) return null;
	if (obj.version !== 1) return null;
	if (typeof obj.teamId !== "string") return null;
	if (typeof obj.taskListId !== "string") return null;
	if (typeof obj.leadName !== "string") return null;
	if (typeof obj.createdAt !== "string") return null;
	if (typeof obj.updatedAt !== "string") return null;
	if (!Array.isArray(obj.members)) return null;

	const style = coerceStyle(obj.style);
	const hooks = coerceHooksPolicy(obj.hooks);
	const members = obj.members.map(coerceMember).filter((m): m is TeamMember => m !== null);
	return {
		version: 1,
		teamId: obj.teamId,
		taskListId: obj.taskListId,
		leadName: sanitizeName(obj.leadName),
		style,
		hooks,
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

export async function ensureTeamConfig(
	teamDir: string,
	init: { teamId: string; taskListId: string; leadName: string; style?: TeamsStyle },
): Promise<TeamConfig> {
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
				leadName: sanitizeName(init.leadName),
				style: init.style ?? "normal",
				createdAt: now,
				updatedAt: now,
				members: [
					{
						name: sanitizeName(init.leadName),
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

export async function setTeamStyle(teamDir: string, style: TeamsStyle): Promise<TeamConfig | null> {
	const file = getTeamConfigPath(teamDir);
	const lock = `${file}.lock`;

	await ensureDir(teamDir);

	return await withLock(
		lock,
		async () => {
			const existing = coerceConfig(await readJson(file));
			if (!existing) return null;

			const now = new Date().toISOString();
			const updated: TeamConfig = { ...existing, style, updatedAt: now };
			await writeJsonAtomic(file, updated);
			return updated;
		},
		{ label: `team-config:style:${style}` },
	);
}

export async function updateTeamHooksPolicy(
	teamDir: string,
	updater: (current: TeamHooksPolicy) => TeamHooksPolicy | undefined,
): Promise<TeamConfig | null> {
	const file = getTeamConfigPath(teamDir);
	const lock = `${file}.lock`;

	await ensureDir(teamDir);

	return await withLock(
		lock,
		async () => {
			const existing = coerceConfig(await readJson(file));
			if (!existing) return null;

			const nextHooks = coerceHooksPolicy(updater(existing.hooks ?? {}));
			const now = new Date().toISOString();
			const updated: TeamConfig = { ...existing, hooks: nextHooks, updatedAt: now };
			await writeJsonAtomic(file, updated);
			return updated;
		},
		{ label: "team-config:hooks-policy" },
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
			const name = sanitizeName(member.name);
			const idx = existing.members.findIndex((m) => m.name === name);
			const prev = idx >= 0 ? existing.members[idx] : undefined;
			if (idx >= 0 && !prev) {
				throw new Error(`Team config corrupted: member index out of range. idx=${idx}`);
			}

			const nextMember: TeamMember = {
				name,
				role: member.role,
				status: member.status,
				addedAt: prev ? prev.addedAt : member.addedAt ?? now,
				lastSeenAt: member.lastSeenAt ?? now,
				sessionFile: member.sessionFile,
				cwd: member.cwd,
				meta: member.meta,
			};

			const members = existing.members.slice();
			if (prev) {
				members[idx] = { ...prev, ...nextMember, addedAt: prev.addedAt };
			} else {
				members.push(nextMember);
			}

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

			const name = sanitizeName(memberName);
			const idx = existing.members.findIndex((m) => m.name === name);
			if (idx < 0) return existing;

			const now = new Date().toISOString();
			const members = existing.members.slice();
			const prev = members[idx];
			if (!prev) return existing;
			members[idx] = {
				...prev,
				status,
				lastSeenAt: extra?.lastSeenAt ?? now,
				meta: extra?.meta ? { ...(prev.meta ?? {}), ...extra.meta } : prev.meta,
			};

			const updated: TeamConfig = { ...existing, updatedAt: now, members };
			await writeJsonAtomic(file, updated);
			return updated;
		},
		{ label: `team-config:status:${memberName}` },
	);
}
