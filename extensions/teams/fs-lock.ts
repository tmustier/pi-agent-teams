import * as fs from "node:fs";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ESRCH") return false;
		// EPERM means a process exists but we cannot signal it.
		return true;
	}
}

type LockReadResult =
	| { kind: "valid"; pid: number; token?: string }
	| { kind: "invalid" }
	| { kind: "missing" };

function readLock(lockFilePath: string): LockReadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(lockFilePath, "utf8");
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid" };
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.pid !== "number") return { kind: "invalid" };
		return { kind: "valid", pid: parsed.pid, token: typeof parsed.token === "string" ? parsed.token : undefined };
	} catch {
		return { kind: "invalid" };
	}
}

export interface LockOptions {
	/** How long to wait to acquire the lock before failing. */
	timeoutMs?: number;
	/** If lock file is older than this, consider it stale and remove it. */
	staleMs?: number;
	/** Poll interval while waiting for lock. */
	pollMs?: number;
	/** Optional label to help debugging (written into lock file). */
	label?: string;
	/** When true, remove extension-owned locks from dead processes and invalid foreign locks after a grace period. */
	recoverAbandoned?: boolean;
	/** Minimum age before invalid/foreign lock files are treated as abandoned. */
	invalidLockGraceMs?: number;
}

export async function withLock<T>(lockFilePath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 60_000;
	const basePollMs = opts.pollMs ?? 50;
	const maxPollMs = Math.max(basePollMs, 1_000);
	const invalidLockGraceMs = opts.invalidLockGraceMs ?? 1_000;
	const start = Date.now();

	let fd: number | null = null;
	let attempt = 0;
	const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

	while (fd === null) {
		try {
			fd = fs.openSync(lockFilePath, "wx");
			const payload = {
				pid: process.pid,
				token,
				createdAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
				label: opts.label,
			};
			fs.writeFileSync(fd, JSON.stringify(payload));
		} catch (err: unknown) {
			if (!isErrnoException(err) || err.code !== "EEXIST") throw err;

			// Stale lock handling
			try {
				const st = fs.statSync(lockFilePath);
				const age = Date.now() - st.mtimeMs;
				if (age > staleMs) {
					const lock = readLock(lockFilePath);
					if (lock.kind === "missing") {
						attempt = 0;
						continue;
					}
					// Do not steal from a live process just because it exceeded staleMs;
					// holders heartbeat the lock mtime while running. Only recover dead/invalid locks.
					if (lock.kind === "invalid" || (lock.kind === "valid" && !isProcessAlive(lock.pid))) {
						fs.unlinkSync(lockFilePath);
						attempt = 0;
						continue;
					}
				}

				if (opts.recoverAbandoned && age > invalidLockGraceMs) {
					const lock = readLock(lockFilePath);
					if (lock.kind === "missing") {
						attempt = 0;
						continue;
					}
					if (lock.kind === "invalid" || (lock.kind === "valid" && !isProcessAlive(lock.pid))) {
						fs.unlinkSync(lockFilePath);
						attempt = 0;
						continue;
					}
				}
			} catch {
				// ignore: stat/read/unlink failures fall through to wait
			}

			const elapsedMs = Date.now() - start;
			if (elapsedMs > timeoutMs) {
				throw new Error(`Timeout acquiring lock: ${lockFilePath}`);
			}

			attempt += 1;
			const expBackoff = Math.min(maxPollMs, basePollMs * 2 ** Math.min(attempt, 6));
			const jitterFactor = 0.5 + Math.random(); // [0.5, 1.5)
			const jitteredBackoff = Math.min(maxPollMs, Math.round(expBackoff * jitterFactor));

			const remainingMs = timeoutMs - elapsedMs;
			const sleepMs = Math.max(1, Math.min(remainingMs, jitteredBackoff));
			await sleep(sleepMs);
		}
	}

	const heartbeatMs = Math.max(100, Math.min(Math.floor(staleMs / 3), 5_000));
	const heartbeat = setInterval(() => {
		if (fd === null) return;
		try {
			const now = new Date();
			fs.futimesSync(fd, now, now);
		} catch {
			// ignore heartbeat failures; stale recovery still checks process liveness.
		}
	}, heartbeatMs);

	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
		try {
			if (fd !== null) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			const lock = readLock(lockFilePath);
			if (lock.kind === "valid" && lock.token === token) fs.unlinkSync(lockFilePath);
		} catch {
			// ignore
		}
	}
}
