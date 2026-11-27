import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { withLock } from "./fs-lock.js";

export const TEAM_ATTACH_CLAIM_FILE = ".attach-claim.json";
export const TEAM_ATTACH_CLAIM_STALE_MS = 30_000;

export interface TeamAttachClaim {
	holderSessionId: string;
	claimedAt: string;
	heartbeatAt: string;
	pid: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumber(obj: Record<string, unknown>, key: string): number | null {
	const value = obj[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTeamAttachClaim(value: unknown): TeamAttachClaim | null {
	if (!isRecord(value)) return null;
	const holderSessionId = getString(value, "holderSessionId");
	const claimedAt = getString(value, "claimedAt");
	const heartbeatAt = getString(value, "heartbeatAt");
	const pid = getNumber(value, "pid");
	if (!holderSessionId || !claimedAt || !heartbeatAt || pid === null) return null;
	return { holderSessionId, claimedAt, heartbeatAt, pid };
}

function getClaimPath(teamDir: string): string {
	return path.join(teamDir, TEAM_ATTACH_CLAIM_FILE);
}

function getClaimLockPath(teamDir: string): string {
	return `${getClaimPath(teamDir)}.lock`;
}

async function readClaimUnchecked(teamDir: string): Promise<TeamAttachClaim | null> {
	const file = getClaimPath(teamDir);
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return parseTeamAttachClaim(parsed);
	} catch {
		return null;
	}
}

async function writeClaimAtomic(teamDir: string, claim: TeamAttachClaim): Promise<void> {
	const file = getClaimPath(teamDir);
	await writeJsonAtomic(file, claim);
}

export function assessAttachClaimFreshness(claim: TeamAttachClaim, nowMs = Date.now(), staleMs = TEAM_ATTACH_CLAIM_STALE_MS): {
	isStale: boolean;
	ageMs: number;
} {
	const heartbeatMs = Date.parse(claim.heartbeatAt);
	if (!Number.isFinite(heartbeatMs)) {
		return { isStale: true, ageMs: Number.POSITIVE_INFINITY };
	}
	const ageMs = Math.max(0, nowMs - heartbeatMs);
	return {
		isStale: ageMs > staleMs,
		ageMs,
	};
}

export async function readTeamAttachClaim(teamDir: string): Promise<TeamAttachClaim | null> {
	return await readClaimUnchecked(teamDir);
}

export type AcquireTeamAttachClaimResult =
	| {
			ok: true;
			claim: TeamAttachClaim;
			replacedClaim?: TeamAttachClaim;
	  }
	| {
			ok: false;
			reason: "claimed_by_other";
			claim: TeamAttachClaim;
	  };

export async function acquireTeamAttachClaim(
	teamDir: string,
	holderSessionId: string,
	opts?: { force?: boolean; staleMs?: number; nowMs?: number },
): Promise<AcquireTeamAttachClaimResult> {
	const lockFile = getClaimLockPath(teamDir);
	const staleMs = opts?.staleMs ?? TEAM_ATTACH_CLAIM_STALE_MS;
	const force = opts?.force === true;

	await fs.promises.mkdir(teamDir, { recursive: true });

	return await withLock(
		lockFile,
		async () => {
			const nowMs = opts?.nowMs ?? Date.now();
			const nowIso = new Date(nowMs).toISOString();
			const current = await readClaimUnchecked(teamDir);
			if (current) {
				const freshness = assessAttachClaimFreshness(current, nowMs, staleMs);
				const sameHolder = current.holderSessionId === holderSessionId;
				if (!sameHolder && !freshness.isStale && !force) {
					return { ok: false, reason: "claimed_by_other", claim: current };
				}

				const claim: TeamAttachClaim = {
					holderSessionId,
					claimedAt: sameHolder ? current.claimedAt : nowIso,
					heartbeatAt: nowIso,
					pid: process.pid,
				};
				await writeClaimAtomic(teamDir, claim);
				return {
					ok: true,
					claim,
					replacedClaim: sameHolder ? undefined : current,
				};
			}

			const claim: TeamAttachClaim = {
				holderSessionId,
				claimedAt: nowIso,
				heartbeatAt: nowIso,
				pid: process.pid,
			};
			await writeClaimAtomic(teamDir, claim);
			return { ok: true, claim };
		},
		{ label: `team-attach-claim:acquire:${holderSessionId}` },
	);
}

export type TeamAttachClaimHeartbeatResult = "updated" | "not_owner" | "missing";

export async function heartbeatTeamAttachClaim(
	teamDir: string,
	holderSessionId: string,
	opts?: { nowMs?: number },
): Promise<TeamAttachClaimHeartbeatResult> {
	const lockFile = getClaimLockPath(teamDir);
	await fs.promises.mkdir(teamDir, { recursive: true });

	return await withLock(
		lockFile,
		async () => {
			const current = await readClaimUnchecked(teamDir);
			if (!current) return "missing";
			if (current.holderSessionId !== holderSessionId) return "not_owner";
			const nowMs = opts?.nowMs ?? Date.now();
			const nowIso = new Date(nowMs).toISOString();
			const updated: TeamAttachClaim = {
				...current,
				heartbeatAt: nowIso,
				pid: process.pid,
			};
			await writeClaimAtomic(teamDir, updated);
			return "updated";
		},
		{ label: `team-attach-claim:heartbeat:${holderSessionId}` },
	);
}

export type TeamAttachClaimReleaseResult = "released" | "not_owner" | "none";

export async function releaseTeamAttachClaim(
	teamDir: string,
	holderSessionId: string,
	opts?: { force?: boolean },
): Promise<TeamAttachClaimReleaseResult> {
	const lockFile = getClaimLockPath(teamDir);
	const file = getClaimPath(teamDir);
	const force = opts?.force === true;
	await fs.promises.mkdir(teamDir, { recursive: true });

	return await withLock(
		lockFile,
		async () => {
			const current = await readClaimUnchecked(teamDir);
			if (!current) return "none";
			if (!force && current.holderSessionId !== holderSessionId) return "not_owner";
			try {
				await fs.promises.unlink(file);
			} catch {
				// ignore: treat as released best effort
			}
			return "released";
		},
		{ label: `team-attach-claim:release:${holderSessionId}` },
	);
}
