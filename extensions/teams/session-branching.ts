import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export type BranchLeafSelection = {
	leafId: string;
	adjusted: boolean;
	reason: "requested" | "clean-turn-assistant" | "clean-turn-user";
};

type MessageLike = Record<string, unknown> & { role: string };

type MessageEntryLike = SessionEntry & {
	type: "message";
	message: MessageLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMessageEntry(entry: SessionEntry): entry is MessageEntryLike {
	if (entry.type !== "message") return false;
	return isRecord(entry.message) && typeof entry.message.role === "string";
}

function isUserMessageEntry(entry: SessionEntry): entry is MessageEntryLike & { message: MessageLike & { role: "user" } } {
	return isMessageEntry(entry) && entry.message.role === "user";
}

function isAssistantToolUseEntry(entry: SessionEntry): entry is MessageEntryLike & { message: MessageLike & { role: "assistant"; stopReason: "toolUse" } } {
	return (
		isMessageEntry(entry) &&
		entry.message.role === "assistant" &&
		typeof entry.message.stopReason === "string" &&
		entry.message.stopReason === "toolUse"
	);
}

function isStableAssistantEntry(entry: SessionEntry): entry is MessageEntryLike & { message: MessageLike & { role: "assistant" } } {
	return (
		isMessageEntry(entry) &&
		entry.message.role === "assistant" &&
		typeof entry.message.stopReason === "string" &&
		entry.message.stopReason !== "toolUse"
	);
}

/**
 * When the leader is mid-turn, the current leaf may point into an unfinished
 * assistant/tool-use path. Branching from that leaf causes workers to inherit
 * the leader's in-progress turn instead of a clean conversation context.
 *
 * In that case, branch from the last stable turn boundary instead:
 * - Prefer the latest completed assistant message (persists as a real branched file)
 * - Otherwise fall back to the latest user message
 */
export function resolveBranchLeafSelection(path: SessionEntry[], requestedLeafId: string): BranchLeafSelection {
	const lastAssistantIndex = [...path].map((entry, index) => ({ entry, index }))
		.reverse()
		.find(({ entry }) => isMessageEntry(entry) && entry.message.role === "assistant")?.index;

	if (lastAssistantIndex === undefined) {
		return { leafId: requestedLeafId, adjusted: false, reason: "requested" };
	}

	const lastAssistant = path[lastAssistantIndex];
	if (!lastAssistant || !isAssistantToolUseEntry(lastAssistant)) {
		return { leafId: requestedLeafId, adjusted: false, reason: "requested" };
	}

	for (let i = lastAssistantIndex - 1; i >= 0; i -= 1) {
		const candidate = path[i];
		if (!candidate) continue;
		if (isStableAssistantEntry(candidate)) {
			return { leafId: candidate.id, adjusted: candidate.id !== requestedLeafId, reason: "clean-turn-assistant" };
		}
	}

	for (let i = lastAssistantIndex - 1; i >= 0; i -= 1) {
		const candidate = path[i];
		if (!candidate) continue;
		if (isUserMessageEntry(candidate)) {
			return { leafId: candidate.id, adjusted: candidate.id !== requestedLeafId, reason: "clean-turn-user" };
		}
	}

	return { leafId: requestedLeafId, adjusted: false, reason: "requested" };
}

export function branchSelectionNote(selection: BranchLeafSelection): string {
	if (!selection.adjusted) return "branch";
	if (selection.reason === "clean-turn-assistant") return "branch(clean-turn)";
	if (selection.reason === "clean-turn-user") return "branch(clean-turn:user-fallback)";
	return "branch";
}
