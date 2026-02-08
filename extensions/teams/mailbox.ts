import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

export interface MailboxMessage {
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
	color?: string;
}

function inboxDir(teamDir: string, namespace: string): string {
	return path.join(teamDir, "mailboxes", sanitizeName(namespace), "inboxes");
}

export function getInboxPath(teamDir: string, namespace: string, agentName: string): string {
	return path.join(inboxDir(teamDir, namespace), `${sanitizeName(agentName)}.json`);
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isLockTimeoutError(err: unknown): err is Error {
	return err instanceof Error && err.message.startsWith("Timeout acquiring lock:");
}

function coerceMailboxMessage(v: unknown): MailboxMessage | null {
	if (!isRecord(v)) return null;
	if (typeof v.from !== "string") return null;
	if (typeof v.text !== "string") return null;
	if (typeof v.timestamp !== "string") return null;
	const read = typeof v.read === "boolean" ? v.read : false;
	const color = typeof v.color === "string" ? v.color : undefined;
	return { from: v.from, text: v.text, timestamp: v.timestamp, read, color };
}

async function readJsonArray(file: string): Promise<unknown[]> {
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, file);
}

/** Append a message to an agent's inbox. */
export async function writeToMailbox(
	teamDir: string,
	namespace: string,
	recipient: string,
	msg: Omit<MailboxMessage, "read"> & { read?: boolean },
): Promise<void> {
	const inboxPath = getInboxPath(teamDir, namespace, recipient);
	const lockPath = `${inboxPath}.lock`;

	await ensureDir(path.dirname(inboxPath));

	await withLock(
		lockPath,
		async () => {
			const arr = await readJsonArray(inboxPath);
			const m: MailboxMessage = {
				from: msg.from,
				text: msg.text,
				timestamp: msg.timestamp,
				read: msg.read ?? false,
				color: msg.color,
			};
			arr.push(m);
			await writeJsonAtomic(inboxPath, arr);
		},
		{ label: `mailbox:write:${namespace}:${recipient}` },
	);
}

/**
 * Read unread messages and mark them as read in a single locked transaction.
 * This is the worker/leader poll primitive.
 */
export async function popUnreadMessages(teamDir: string, namespace: string, agentName: string): Promise<MailboxMessage[]> {
	const inboxPath = getInboxPath(teamDir, namespace, agentName);
	const lockPath = `${inboxPath}.lock`;

	await ensureDir(path.dirname(inboxPath));

	try {
		return await withLock(
			lockPath,
			async () => {
				const arr = (await readJsonArray(inboxPath))
					.map(coerceMailboxMessage)
					.filter((m): m is MailboxMessage => m !== null);
				if (arr.length === 0) return [];

				const unread: MailboxMessage[] = [];
				const updated = arr.map((m) => {
					if (!m.read) {
						const next = { ...m, read: true };
						unread.push(next);
						return next;
					}
					return m;
				});

				if (unread.length) await writeJsonAtomic(inboxPath, updated);
				return unread;
			},
			{ label: `mailbox:pop:${namespace}:${agentName}` },
		);
	} catch (err: unknown) {
		// In practice this can happen if a previous process crashed and left a non-stale
		// lockfile behind. Treat as transient and try again on the next poll tick.
		if (isLockTimeoutError(err)) return [];
		throw err;
	}
}
