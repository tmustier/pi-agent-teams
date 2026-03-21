import type { AgentEvent } from "@mariozechner/pi-agent-core";

// ── Transcript types ──

export type TranscriptEntry =
	| { kind: "text"; text: string; timestamp: number }
	| { kind: "tool_start"; toolName: string; content: string | null; timestamp: number }
	| { kind: "tool_end"; toolName: string; content: string | null; isError: boolean; durationMs: number; timestamp: number }
	| { kind: "turn_end"; turnNumber: number; tokens: number; timestamp: number };

const MAX_TRANSCRIPT = 200;

export class TranscriptLog {
	private entries: TranscriptEntry[] = [];

	push(entry: TranscriptEntry): void {
		this.entries.push(entry);
		if (this.entries.length > MAX_TRANSCRIPT) {
			this.entries.splice(0, this.entries.length - MAX_TRANSCRIPT);
		}
	}

	getEntries(): readonly TranscriptEntry[] {
		return this.entries;
	}

	get length(): number {
		return this.entries.length;
	}

	reset(): void {
		this.entries = [];
	}
}

// ── Tool content extraction ──
// Extracts a compact, human-readable summary from tool args/results.
// Budget: ≤120 chars to fit one terminal line minus timestamp prefix.

const MAX_CONTENT_LEN = 120;

function truncateContent(s: string, maxLen: number = MAX_CONTENT_LEN): string {
	const oneLine = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Extract a display-friendly summary from tool start args.
 *
 * Known tool shapes:
 *   read  → { path }
 *   edit  → { path }
 *   write → { path }
 *   bash  → { command }
 *   grep  → { pattern, path? }
 *   glob  → { pattern }
 *
 * Falls back to the first short string value for unknown tools.
 */
function extractStartContent(toolName: string, args: unknown): string | null {
	if (!isRecord(args)) return null;
	const key = toolName.toLowerCase();

	if (key === "read" || key === "edit" || key === "write") {
		const p = args.path;
		return typeof p === "string" ? truncateContent(p) : null;
	}
	if (key === "bash") {
		const cmd = args.command;
		return typeof cmd === "string" ? truncateContent(cmd) : null;
	}
	if (key === "grep") {
		const pattern = args.pattern;
		const path = args.path;
		if (typeof pattern !== "string") return null;
		const suffix = typeof path === "string" ? ` in ${path}` : "";
		return truncateContent(`/${pattern}/${suffix}`);
	}
	if (key === "glob" || key === "find") {
		const pattern = args.pattern;
		return typeof pattern === "string" ? truncateContent(pattern) : null;
	}

	// Unknown tool: show the first short string arg value (if any).
	for (const v of Object.values(args)) {
		if (typeof v === "string" && v.length > 0 && v.length <= MAX_CONTENT_LEN) {
			return truncateContent(v);
		}
	}
	return null;
}

/**
 * Extract a display-friendly summary from tool end result.
 *
 * For errors: first line of error text.
 * For success: null (the tool_end line already shows tool name + duration;
 * adding full output would be noisy).
 */
function extractEndContent(isError: boolean, result: unknown): string | null {
	if (!isError) return null;
	if (typeof result === "string") return truncateContent(result);
	if (isRecord(result)) {
		const msg = result.error ?? result.message ?? result.stderr ?? result.output;
		if (typeof msg === "string") return truncateContent(msg);
	}
	return null;
}

export class TranscriptTracker {
	private logs = new Map<string, TranscriptLog>();
	private toolStarts = new Map<string, Map<string, number>>(); // name -> toolCallId -> startTimestamp
	private pendingText = new Map<string, string>(); // name -> accumulated text
	private turnCounts = new Map<string, number>();
	private lastTokens = new Map<string, number>(); // name -> tokens from last message_end

	handleEvent(name: string, ev: AgentEvent): void {
		const log = this.getOrCreate(name);
		const now = Date.now();

		if (ev.type === "message_update") {
			const ame = ev.assistantMessageEvent;
			if (ame.type === "text_delta") {
				const cur = this.pendingText.get(name) ?? "";
				this.pendingText.set(name, cur + ame.delta);
				// Flush complete lines
				this.flushText(name, log, now, false);
			}
			return;
		}

		if (ev.type === "tool_execution_start") {
			// Flush any pending text before a tool starts
			this.flushText(name, log, now, true);
			const starts = this.toolStarts.get(name) ?? new Map<string, number>();
			starts.set(ev.toolCallId, now);
			this.toolStarts.set(name, starts);
			const content = extractStartContent(ev.toolName, ev.args);
			log.push({ kind: "tool_start", toolName: ev.toolName, content, timestamp: now });
			return;
		}

		if (ev.type === "tool_execution_end") {
			const starts = this.toolStarts.get(name);
			const startTs = starts?.get(ev.toolCallId);
			const durationMs = startTs === undefined ? 0 : now - startTs;
			starts?.delete(ev.toolCallId);
			const content = extractEndContent(ev.isError, ev.result);
			log.push({ kind: "tool_end", toolName: ev.toolName, content, isError: ev.isError, durationMs, timestamp: now });
			return;
		}

		if (ev.type === "message_end") {
			// Capture tokens for use in the turn_end entry
			const msg: unknown = ev.message;
			if (isRecord(msg)) {
				const usage = msg.usage;
				if (isRecord(usage) && typeof usage.totalTokens === "number") {
					this.lastTokens.set(name, (this.lastTokens.get(name) ?? 0) + usage.totalTokens);
				}
			}
			return;
		}

		if (ev.type === "agent_end") {
			// Flush remaining text
			this.flushText(name, log, now, true);
			const turn = (this.turnCounts.get(name) ?? 0) + 1;
			this.turnCounts.set(name, turn);
			const tokens = this.lastTokens.get(name) ?? 0;
			log.push({ kind: "turn_end", turnNumber: turn, tokens, timestamp: now });
			this.lastTokens.set(name, 0);
			return;
		}
	}

	get(name: string): TranscriptLog {
		return this.logs.get(name) ?? new TranscriptLog();
	}

	reset(name: string): void {
		this.logs.delete(name);
		this.toolStarts.delete(name);
		this.pendingText.delete(name);
		this.turnCounts.delete(name);
		this.lastTokens.delete(name);
	}

	private getOrCreate(name: string): TranscriptLog {
		const existing = this.logs.get(name);
		if (existing) return existing;
		const created = new TranscriptLog();
		this.logs.set(name, created);
		return created;
	}

	private flushText(name: string, log: TranscriptLog, timestamp: number, force: boolean): void {
		const buf = this.pendingText.get(name);
		if (!buf) return;

		// Split into lines; keep the last incomplete line unless forced
		const parts = buf.split("\n");
		if (force) {
			// Flush everything
			for (const part of parts) {
				const trimmed = part.trimEnd();
				if (trimmed) log.push({ kind: "text", text: trimmed, timestamp });
			}
			this.pendingText.delete(name);
		} else if (parts.length > 1) {
			// Flush all complete lines, keep the last (potentially incomplete) part
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				if (part === undefined) continue;
				const trimmed = part.trimEnd();
				if (trimmed) log.push({ kind: "text", text: trimmed, timestamp });
			}
			this.pendingText.set(name, parts[parts.length - 1] ?? "");
		}
	}
}

// ── Activity types ──

type TrackedEventType = "tool_execution_start" | "tool_execution_end" | "agent_end" | "message_end";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export interface TeammateActivity {
	toolUseCount: number;
	currentToolName: string | null;
	lastToolName: string | null;
	turnCount: number;
	totalTokens: number;
	recentEvents: Array<{ type: TrackedEventType; toolName?: string; timestamp: number }>;
}

const MAX_RECENT = 10;

function emptyActivity(): TeammateActivity {
	return {
		toolUseCount: 0,
		currentToolName: null,
		lastToolName: null,
		turnCount: 0,
		totalTokens: 0,
		recentEvents: [],
	};
}

export class ActivityTracker {
	private data = new Map<string, TeammateActivity>();

	handleEvent(name: string, ev: AgentEvent): void {
		const a = this.getOrCreate(name);
		const now = Date.now();

		if (ev.type === "tool_execution_start") {
			a.currentToolName = ev.toolName;
			a.recentEvents.push({ type: ev.type, toolName: ev.toolName, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			return;
		}

		if (ev.type === "tool_execution_end") {
			const toolName = a.currentToolName ?? ev.toolName;
			a.toolUseCount++;
			a.lastToolName = toolName;
			a.currentToolName = null;
			a.recentEvents.push({ type: ev.type, toolName, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			return;
		}

		if (ev.type === "agent_end") {
			a.turnCount++;
			a.recentEvents.push({ type: ev.type, timestamp: now });
			if (a.recentEvents.length > MAX_RECENT) a.recentEvents.shift();
			return;
		}

		if (ev.type === "message_end") {
			const msg: unknown = ev.message;
			if (!isRecord(msg)) return;
			const usage = msg.usage;
			if (!isRecord(usage)) return;
			const totalTokens = usage.totalTokens;
			if (typeof totalTokens === "number") a.totalTokens += totalTokens;
		}
	}

	get(name: string): TeammateActivity {
		return this.data.get(name) ?? emptyActivity();
	}

	reset(name: string): void {
		this.data.delete(name);
	}

	private getOrCreate(name: string): TeammateActivity {
		const existing = this.data.get(name);
		if (existing) return existing;

		const created = emptyActivity();
		this.data.set(name, created);
		return created;
	}
}
