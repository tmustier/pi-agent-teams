import * as fs from "node:fs";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
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

			// Stale lock handling
			try {
				const st = fs.statSync(lockFilePath);
				const age = Date.now() - st.mtimeMs;
				if (age > staleMs) {
					fs.unlinkSync(lockFilePath);
					attempt = 0;
					continue;
				}
			} catch {
				// ignore: stat/unlink failures fall through to wait
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
