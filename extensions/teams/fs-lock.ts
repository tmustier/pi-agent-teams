import * as fs from "node:fs";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
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
	const pollMs = opts.pollMs ?? 50;
	const start = Date.now();

	let fd: number | null = null;

	while (fd === null) {
		try {
			fd = fs.openSync(lockFilePath, "wx");
			const payload = {
				pid: process.pid,
				createdAt: new Date().toISOString(),
				label: opts.label,
			};
			fs.writeFileSync(fd, JSON.stringify(payload));
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			// Stale lock handling
			try {
				const st = fs.statSync(lockFilePath);
				const age = Date.now() - st.mtimeMs;
				if (age > staleMs) {
					fs.unlinkSync(lockFilePath);
					continue;
				}
			} catch {
				// ignore: stat/unlink failures fall through to wait
			}

			if (Date.now() - start > timeoutMs) {
				throw new Error(`Timeout acquiring lock: ${lockFilePath}`);
			}
			await sleep(pollMs);
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
