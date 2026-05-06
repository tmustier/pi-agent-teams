import { spawn as nodeSpawn } from "node:child_process";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type TeammateStatus = "starting" | "idle" | "streaming" | "stopped" | "error";

export interface TeammateHandle {
	readonly name: string;
	readonly sessionFile?: string;
	status: TeammateStatus;
	lastAssistantText: string;
	lastError: string | null;
	currentTaskId: string | null;
	lastStatusChangeAt: number;
	lastEventAt: number;
	onEvent(listener: (ev: AgentEvent) => void): () => void;
	onClose(listener: (code: number | null) => void): () => void;
	getStderr(): string;
	start(opts: { cwd: string; env: Record<string, string>; args: string[] }): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<unknown>;
	setSessionName(name: string): Promise<void>;
}

type RpcCommand =
	| { id: string; type: "prompt"; message: string }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "follow_up"; message: string }
	| { id: string; type: "abort" }
	| { id: string; type: "get_state" }
	| { id: string; type: "set_session_name"; name: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type RpcCommandWithoutId = DistributiveOmit<RpcCommand, "id">;

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function safeParseJsonLine(line: string): unknown | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isRpcResponse(v: unknown): v is RpcResponse {
	if (!isRecord(v)) return false;
	if (v.type !== "response") return false;
	if (typeof v.command !== "string") return false;
	if (typeof v.success !== "boolean") return false;
	if (v.id !== undefined && typeof v.id !== "string") return false;
	if (v.error !== undefined && typeof v.error !== "string") return false;
	return true;
}

function isAgentEvent(v: unknown): v is AgentEvent {
	if (!isRecord(v)) return false;
	if (typeof v.type !== "string") return false;

	// Validate the minimal shapes we actually dereference below.
	if (v.type === "message_update") {
		const ame = v.assistantMessageEvent;
		if (!isRecord(ame)) return false;
		if (typeof ame.type !== "string") return false;
		if (ame.type === "text_delta" && typeof ame.delta !== "string") return false;
		return true;
	}

	if (v.type === "tool_execution_start" || v.type === "tool_execution_update" || v.type === "tool_execution_end") {
		if (typeof v.toolCallId !== "string") return false;
		if (typeof v.toolName !== "string") return false;
		return true;
	}

	return (
		v.type === "agent_start" ||
		v.type === "agent_end" ||
		v.type === "turn_start" ||
		v.type === "turn_end" ||
		v.type === "message_start" ||
		v.type === "message_end"
	);
}

export class TeammateRpc implements TeammateHandle {
	readonly name: string;
	readonly sessionFile?: string;

	status: TeammateStatus = "starting";
	lastAssistantText = "";
	lastError: string | null = null;

	/** Task currently assigned by the team lead (if any). */
	currentTaskId: string | null = null;

	/** Epoch ms when the current `status` was entered. */
	lastStatusChangeAt: number = Date.now();

	/** Epoch ms of the most recent agent event received from the child process. */
	lastEventAt: number = Date.now();

	private proc: ReturnType<typeof nodeSpawn> | null = null;
	private stopping = false;
	private readonly spawnFn: typeof nodeSpawn;
	private pending = new Map<string, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 0;
	private buffer = "";
	private stderr = "";
	private eventListeners: Array<(ev: AgentEvent) => void> = [];
	private closeListeners: Array<(code: number | null) => void> = [];

	constructor(name: string, sessionFile?: string, spawnFn: typeof nodeSpawn = nodeSpawn) {
		this.name = name;
		this.sessionFile = sessionFile;
		this.spawnFn = spawnFn;
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
		return this.stderr;
	}

	async start(opts: { cwd: string; env: Record<string, string>; args: string[] }): Promise<void> {
		if (this.proc) throw new Error("Teammate already started");

		const proc = this.spawnFn("pi", ["--mode", "rpc", ...opts.args], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		this.stopping = false;

		proc.on("error", (err) => {
			if (this.proc === proc) this.proc = null;
			this.status = this.stopping ? "stopped" : "error";
			this.lastStatusChangeAt = Date.now();
			if (!this.stopping) this.lastError = String(err);
			for (const [id, p] of this.pending.entries()) {
				p.reject(new Error(`Process error before response (id=${id}): ${String(err)}`));
			}
			this.pending.clear();
		});

		proc.stderr?.on("data", (d) => {
			this.stderr += d.toString();
		});

		proc.stdout?.on("data", (d) => {
			this.buffer += d.toString();
			let idx: number;
			while ((idx = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 1);
				this.handleLine(line);
			}
		});

		proc.on("close", (code) => {
			if (this.proc === proc) this.proc = null;
			const intentionalStop = this.stopping || this.status === "stopped";
			this.status = intentionalStop || code === 0 ? "stopped" : "error";
			this.lastStatusChangeAt = Date.now();
			if (!intentionalStop && code !== 0) this.lastError = `Teammate process exited with code ${code}`;
			this.stopping = false;
			for (const [id, p] of this.pending.entries()) {
				p.reject(new Error(`Process exited before response (id=${id})`));
			}
			this.pending.clear();
			for (const l of this.closeListeners) l(code);
		});

		// Give the child a moment to boot.
		await new Promise((r) => setTimeout(r, 120));
		this.status = "idle";
		const bootNow = Date.now();
		this.lastStatusChangeAt = bootNow;
		this.lastEventAt = bootNow;
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.stopping = true;
		void this.abort().catch(() => {
			// ignore
		});
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (this.proc === proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
		}, 1000);
		this.status = "stopped";
		this.lastStatusChangeAt = Date.now();
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async getState(): Promise<unknown> {
		const resp = await this.send({ type: "get_state" });
		return resp.data;
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	private handleLine(line: string) {
		if (!line.trim()) return;
		const obj = safeParseJsonLine(line);
		if (obj === null) return;

		// Response
		if (isRpcResponse(obj)) {
			if (typeof obj.id !== "string") return;
			const pending = this.pending.get(obj.id);
			if (!pending) return;
			this.pending.delete(obj.id);
			pending.resolve(obj);
			return;
		}

		// Agent event
		if (!isAgentEvent(obj)) return;
		const ev = obj;
		const now = Date.now();
		this.lastEventAt = now;

		if (ev.type === "agent_start") {
			this.status = "streaming";
			this.lastStatusChangeAt = now;
			this.lastAssistantText = "";
		}
		if (ev.type === "agent_end") {
			this.status = "idle";
			this.lastStatusChangeAt = now;
		}
		if (ev.type === "message_update") {
			const ame = ev.assistantMessageEvent;
			if (ame.type === "text_delta") {
				this.lastAssistantText += ame.delta;
			}
		}

		for (const l of this.eventListeners) l(ev);
	}

	private async send(cmd: RpcCommandWithoutId): Promise<RpcResponse> {
		if ((this.stopping && cmd.type !== "abort") || !this.proc || !this.proc.stdin) throw new Error("Teammate is not running");
		const id = `req-${this.name}-${this.nextId++}`;
		const full = { id, ...cmd } satisfies RpcCommand;

		const payload = JSON.stringify(full) + "\n";
		this.proc.stdin.write(payload);

		return await new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				reject(new Error(`Timeout waiting for response (id=${id}, cmd=${full.type})`));
			}, 60_000);
		});
	}
}
