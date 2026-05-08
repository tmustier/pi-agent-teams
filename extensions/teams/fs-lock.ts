import * as fs from "node:fs";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

/**
 * Check if a process with the given PID is alive.
 * Returns true if the process exists (even if zombie), false otherwise.
 */
function isPidAlive(pid: number): boolean {
	try {
		// signal 0 = existence check, does not actually send a signal
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the PID from an existing lock file. Returns null if file doesn't exist
 * or content is not valid JSON with a numeric pid field.
 */
function readLockPid(lockFilePath: string): number | null {
	try {
		const data = fs.readFileSync(lockFilePath, "utf8");
		const parsed = JSON.parse(data);
		return typeof parsed.pid === "number" ? parsed.pid : null;
	} catch {
		return null;
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
}

/**
 * Acquire an exclusive file lock and run `fn`.
 *
 * Staleness is determined by TWO heuristics (either triggers cleanup):
 *   1. The lock file's mtime exceeds `staleMs` (default 60s).
 *   2. The PID recorded in the lock file is no longer alive.
 *
 * To avoid the thundering-herd problem where multiple processes all unlink
 * the same stale lock and then race to re-create it, we use rename-based
 * atomic replacement: each contender renames the stale lock to a unique
 * temp path. Only the process that successfully renamed it proceeds to
 * create a new lock; others see the lock is gone and loop back to try
 * `openSync("wx")`.
 */
export async function withLock<T>(lockFilePath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 60_000;
	const basePollMs = opts.pollMs ?? 50;
	const maxPollMs = Math.max(basePollMs, 1_000);
	const start = Date.now();

	let fd: number | null = null;
	let attempt = 0;

	while (fd === null) {
		try {
			fd = fs.openSync(lockFilePath, "wx");
			const payload = {
				pid: process.pid,
				createdAt: new Date().toISOString(),
				label: opts.label,
			};
			fs.writeFileSync(fd, JSON.stringify(payload));
		} catch (err: unknown) {
			if (!isErrnoException(err) || err.code !== "EEXIST") throw err;

			// Stale lock handling — use atomic rename to avoid thundering herd
			try {
				const st = fs.statSync(lockFilePath);
				const age = Date.now() - st.mtimeMs;
				const lockPid = readLockPid(lockFilePath);
				const pidDead = lockPid !== null && lockPid !== process.pid && !isPidAlive(lockPid);

				if (age > staleMs || pidDead) {
					// Atomically steal the lock by renaming it to a unique temp path.
					// Only one contender will succeed at the rename; others will get ENOENT.
					const trashPath = `${lockFilePath}.stale.${process.pid}.${Date.now()}`;
					fs.renameSync(lockFilePath, trashPath);
					// Clean up the trash asynchronously — don't block the lock acquisition
					try { fs.unlinkSync(trashPath); } catch { /* best effort */ }
					attempt = 0;
					continue;
				}
			} catch (err2: unknown) {
				// ENOENT means another contender already stole it — loop back immediately
				if (isErrnoException(err2) && (err2 as NodeJS.ErrnoException).code === "ENOENT") {
					attempt = 0;
					continue;
				}
				// Other stat/rename/read failures fall through to wait
			}

			const elapsedMs = Date.now() - start;
			if (elapsedMs > timeoutMs) {
				// Include diagnostic info in the error for easier debugging
				const lockPid = readLockPid(lockFilePath);
				const pidInfo = lockPid !== null ? ` (held by PID ${lockPid}, alive=${isPidAlive(lockPid)})` : "";
				throw new Error(
					`Timeout acquiring lock: ${lockFilePath}${pidInfo}. ` +
					`If the lock is stale, delete it manually: rm -f ${lockFilePath}`,
				);
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

	try {
		return await fn();
	} finally {
		try {
			if (fd !== null) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockFilePath);
		} catch {
			// ignore
		}
	}
}
