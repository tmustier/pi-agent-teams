import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";

export interface MailboxMessage {
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
	color?: string;
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function inboxDir(teamDir: string, namespace: string): string {
	return path.join(teamDir, "mailboxes", sanitize(namespace), "inboxes");
}

export function getInboxPath(teamDir: string, namespace: string, agentName: string): string {
	return path.join(inboxDir(teamDir, namespace), `${sanitize(agentName)}.json`);
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

async function readJsonArray(file: string): Promise<any[]> {
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function writeJsonAtomic(file: string, data: any): Promise<void> {
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

	return await withLock(
		lockPath,
		async () => {
			const arr = (await readJsonArray(inboxPath)) as MailboxMessage[];
			if (arr.length === 0) return [];

			const unread: MailboxMessage[] = [];
			const updated = arr.map((m) => {
				if (m && typeof m === "object" && !m.read) {
					unread.push({ ...m, read: true });
					return { ...m, read: true };
				}
				return m;
			});

			if (unread.length) await writeJsonAtomic(inboxPath, updated);
			return unread;
		},
		{ label: `mailbox:pop:${namespace}:${agentName}` },
	);
}
