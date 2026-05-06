import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { writeToMailbox } from "./mailbox.js";
import { TEAM_MAILBOX_NS } from "./protocol.js";
import type { TeammateHandle, TeammateStatus } from "./teammate-rpc.js";
import { killPane, spawnWorkerPane, type TmuxContext } from "./tmux-layout.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnvCommand(env: Record<string, string>, args: readonly string[]): string {
	const envParts = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
	return ["env", ...envParts, "pi", ...args.map(shellQuote)].join(" ");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function extractSessionMessage(v: unknown): Record<string, unknown> | null {
	if (!isRecord(v)) return null;
	if (typeof v.role === "string") return v;
	const message = v.message;
	if (isRecord(message) && typeof message.role === "string") return message;
	const entry = v.entry;
	if (isRecord(entry)) {
		if (typeof entry.role === "string") return entry;
		const nested = entry.message;
		if (isRecord(nested) && typeof nested.role === "string") return nested;
	}
	return null;
}

export class TeammateTmux implements TeammateHandle {
	readonly name: string;
	readonly sessionFile?: string;

	status: TeammateStatus = "starting";
	lastAssistantText = "";
	lastError: string | null = null;
	currentTaskId: string | null = null;
	lastStatusChangeAt: number = Date.now();
	lastEventAt: number = Date.now();

	private paneId: string | null = null;
	private readonly eventListeners: Array<(ev: AgentEvent) => void> = [];
	private readonly closeListeners: Array<(code: number | null) => void> = [];
	private sessionOffset = 0;
	private sessionRemainder = "";
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private activeToolNames = new Map<string, string>();

	constructor(opts: {
		name: string;
		sessionFile?: string;
		teamDir: string;
		taskListId: string;
		leadName: string;
		tmuxContext: TmuxContext;
		knownWorkerPaneIds: () => string[];
	}) {
		this.name = opts.name;
		this.sessionFile = opts.sessionFile;
		this.teamDir = opts.teamDir;
		this.taskListId = opts.taskListId;
		this.leadName = opts.leadName;
		this.tmuxContext = opts.tmuxContext;
		this.knownWorkerPaneIds = opts.knownWorkerPaneIds;
	}

	private readonly teamDir: string;
	private readonly taskListId: string;
	private readonly leadName: string;
	private readonly tmuxContext: TmuxContext;
	private readonly knownWorkerPaneIds: () => string[];

	get tmuxPaneId(): string | null {
		return this.paneId;
	}

	onEvent(listener: (ev: AgentEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	onClose(listener: (code: number | null) => void): () => void {
		this.closeListeners.push(listener);
		return () => {
			const idx = this.closeListeners.indexOf(listener);
			if (idx >= 0) this.closeListeners.splice(idx, 1);
		};
	}

	getStderr(): string {
		return "";
	}

	async start(opts: { cwd: string; env: Record<string, string>; args: string[] }): Promise<void> {
		if (this.paneId) throw new Error("Teammate tmux pane already started");
		const command = buildEnvCommand(opts.env, opts.args);
		this.paneId = await spawnWorkerPane({
			ctx: this.tmuxContext,
			command,
			cwd: opts.cwd,
			workerName: this.name,
			knownWorkerPaneIds: this.knownWorkerPaneIds(),
		});

		const now = Date.now();
		this.status = "idle";
		this.lastStatusChangeAt = now;
		this.lastEventAt = now;
		this.startActivityPolling();
	}

	async stop(): Promise<void> {
		if (this.status === "stopped") return;
		try {
			await this.sendControlMessage({
				type: "shutdown_request",
				requestId: randomUUID(),
				from: this.leadName,
				timestamp: new Date().toISOString(),
				reason: "Stopped by leader",
			});
		} catch {
			// Best-effort mailbox shutdown before killing the pane.
		}

		await sleep(500);
		if (this.paneId) {
			try {
				await killPane(this.paneId);
			} catch {
				// Pane may already be gone.
			}
		}

		this.stopActivityPolling();
		this.status = "stopped";
		this.lastStatusChangeAt = Date.now();
		for (const listener of this.closeListeners) listener(0);
	}

	async prompt(message: string): Promise<void> {
		await this.sendText(message, false);
	}

	async steer(message: string): Promise<void> {
		await this.sendText(message, true);
	}

	async followUp(message: string): Promise<void> {
		await this.sendText(message, true);
	}

	async abort(): Promise<void> {
		await this.sendControlMessage({
			type: "abort_request",
			requestId: randomUUID(),
			from: this.leadName,
			reason: "Abort requested by leader",
			timestamp: new Date().toISOString(),
		});
	}

	async getState(): Promise<unknown> {
		return {
			backend: "tmux",
			name: this.name,
			status: this.status,
			paneId: this.paneId,
			tmuxSession: this.tmuxContext.sessionName,
			tmuxWindow: this.tmuxContext.windowId,
		};
	}

	async setSessionName(name: string): Promise<void> {
		await this.sendControlMessage({
			type: "set_session_name",
			name,
			from: this.leadName,
			timestamp: new Date().toISOString(),
		});
	}

	async refreshSessionActivity(): Promise<void> {
		if (!this.sessionFile) return;
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(this.sessionFile);
		} catch {
			return;
		}
		if (stat.size < this.sessionOffset) {
			this.sessionOffset = 0;
			this.sessionRemainder = "";
		}
		if (stat.size === this.sessionOffset) return;
		const fh = await fs.promises.open(this.sessionFile, "r");
		try {
			const len = stat.size - this.sessionOffset;
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, this.sessionOffset);
			this.sessionOffset = stat.size;
			const text = this.sessionRemainder + buf.toString("utf8");
			const lines = text.split(/\r?\n/);
			this.sessionRemainder = lines.pop() ?? "";
			for (const line of lines) this.handleSessionLine(line);
		} finally {
			await fh.close();
		}
	}

	private startActivityPolling(): void {
		if (!this.sessionFile || this.pollTimer) return;
		try {
			this.sessionOffset = fs.existsSync(this.sessionFile) ? fs.statSync(this.sessionFile).size : 0;
		} catch {
			this.sessionOffset = 0;
		}
		this.pollTimer = setInterval(() => {
			void this.refreshSessionActivity().catch(() => undefined);
		}, 500);
	}

	private stopActivityPolling(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	private handleSessionLine(line: string): void {
		if (!line.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const msg = extractSessionMessage(parsed);
		if (!msg) return;
		const role = typeof msg.role === "string" ? msg.role : null;
		if (role === "user") {
			this.emitSynthetic({ type: "agent_start" } as AgentEvent);
			return;
		}
		if (role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			let sawTool = false;
			for (const item of content) {
				if (!isRecord(item) || item.type !== "toolCall") continue;
				const id = typeof item.id === "string" ? item.id : `tmux-${Date.now()}-${this.activeToolNames.size}`;
				const name = typeof item.name === "string" ? item.name : "tool";
				this.activeToolNames.set(id, name);
				sawTool = true;
				this.emitSynthetic({ type: "tool_execution_start", toolCallId: id, toolName: name, args: item.arguments } as AgentEvent);
			}
			const text = content.flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [])).join("\n");
			if (text) this.emitSynthetic({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } } as AgentEvent);
			this.emitSynthetic({ type: "message_end", message: msg } as unknown as AgentEvent);
			if (!sawTool && text) this.emitSynthetic({ type: "agent_end" } as AgentEvent);
			return;
		}
		if (role === "toolResult") {
			const id = typeof msg.toolCallId === "string" ? msg.toolCallId : "unknown";
			const name = typeof msg.toolName === "string" ? msg.toolName : (this.activeToolNames.get(id) ?? "tool");
			this.activeToolNames.delete(id);
			this.emitSynthetic({ type: "tool_execution_end", toolCallId: id, toolName: name, result: msg.content, isError: msg.isError === true } as AgentEvent);
		}
	}

	private emitSynthetic(ev: AgentEvent): void {
		const now = Date.now();
		this.lastEventAt = now;
		if (ev.type === "agent_start" || ev.type === "tool_execution_start") {
			if (this.status !== "streaming") this.lastStatusChangeAt = now;
			this.status = "streaming";
			if (ev.type === "agent_start") this.lastAssistantText = "";
		}
		if (ev.type === "agent_end") {
			this.status = "idle";
			this.lastStatusChangeAt = now;
		}
		if (ev.type === "message_update") {
			const ame = ev.assistantMessageEvent;
			if (ame.type === "text_delta") this.lastAssistantText += ame.delta;
		}
		for (const listener of this.eventListeners) listener(ev);
	}

	private async sendText(text: string, urgent: boolean): Promise<void> {
		await writeToMailbox(this.teamDir, TEAM_MAILBOX_NS, this.name, {
			from: this.leadName,
			text,
			timestamp: new Date().toISOString(),
			...(urgent ? { urgent: true } : {}),
		});
	}

	private async sendControlMessage(payload: Record<string, unknown>): Promise<void> {
		await writeToMailbox(this.teamDir, TEAM_MAILBOX_NS, this.name, {
			from: this.leadName,
			text: JSON.stringify(payload),
			timestamp: new Date().toISOString(),
		});
	}
}
