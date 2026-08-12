import * as fs from "node:fs";
import * as path from "node:path";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1_000, 2_000, 4_000] as const;

type Rename = typeof fs.promises.rename;

function isRetryableWindowsRenameError(error: unknown): boolean {
	return process.platform === "win32" && WINDOWS_RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

/** Retry transient Windows file-share violations while another process releases a read handle. */
export async function renameWithRetry(source: string, destination: string, rename: Rename = fs.promises.rename): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(source, destination);
			return;
		} catch (error) {
			const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
			if (!isRetryableWindowsRenameError(error) || delayMs === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");

	let renamed = false;
	try {
		await renameWithRetry(tmp, file);
		renamed = true;
	} finally {
		if (!renamed) await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
	}
}
