/** Offline regression: npx tsx scripts/worker-delivery-test.mts
 * Exercises mailbox/event delivery, then loads the worker in the real Pi SDK.
 * No network, model credentials, or external Pi installation required.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
	SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { popUnreadMessages, writeToMailbox } from "../extensions/teams/mailbox.js";
import { TEAM_MAILBOX_NS } from "../extensions/teams/protocol.js";
import { createTask, getTask } from "../extensions/teams/task-store.js";
import { runWorker } from "../extensions/teams/worker.js";

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(20);
	}
	assert.fail(`Timed out: ${label}`);
}

async function environment(autoClaim = false, plan = false) {
	const root = await mkdtemp(path.join(tmpdir(), "worker-delivery-"));
	const values = {
		PI_TEAMS_ROOT_DIR: root, PI_TEAMS_TEAM_ID: "delivery", PI_TEAMS_TASK_LIST_ID: "tasks",
		PI_TEAMS_AGENT_NAME: "worker", PI_TEAMS_LEAD_NAME: "lead", PI_TEAMS_WORKER: "1",
		PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0", PI_TEAMS_PLAN_REQUIRED: plan ? "1" : "0",
	};
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	const signalListeners = process.listeners("SIGTERM");
	return {
		root, teamDir: path.join(root, "delivery"),
		async dispose() {
			// runWorker installs a process-level handler; don't leak it between test workers.
			for (const listener of process.listeners("SIGTERM")) {
				if (!signalListeners.includes(listener)) process.removeListener("SIGTERM", listener);
			}
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			// Allow the worker's in-flight poll/sleep to exit before removing its files.
			await sleep(600);
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function mailbox(teamDir: string, text: string, namespace = TEAM_MAILBOX_NS, urgent = false) {
	await writeToMailbox(teamDir, namespace, "worker", {
		from: "lead", text, timestamp: new Date().toISOString(), ...(urgent ? { urgent: true } : {}),
	});
}

type Delivery = {
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
	options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
};

async function harness(autoClaim = false, plan = false) {
	const env = await environment(autoClaim, plan);
	type Handler = (event: { messages: unknown[] }, ctx: ExtensionContext) => Promise<void>;
	const handlers = new Map<string, Handler>();
	const deliveries: Delivery[] = [];
	const accepted: Delivery[] = [];
	const context = { cwd: env.root, sessionManager: { getSessionFile: () => undefined } } as ExtensionContext;
	let busy = true; // Pi may be busy before worker sees agent_start, or after agent_end.
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => {}, getActiveTools: () => ["read", "write"], setActiveTools: () => {},
		sendUserMessage(content: Delivery["content"], options: Delivery["options"]) {
			const delivery = { content, options };
			deliveries.push(delivery);
			// Model the real SDK's busy contract, recording rejection rather than throwing
			// (the actual extension API reports asynchronous failures via extension errors).
			if (!busy || options?.deliverAs) accepted.push(delivery);
		},
	} as unknown as ExtensionAPI;
	runWorker(pi);
	const emit = async (name: string) => { await handlers.get(name)?.({ messages: [] }, context); };
	return {
		...env, deliveries, accepted, emit, setBusy: (value: boolean) => { busy = value; },
		async dispose() { await emit("session_shutdown"); await env.dispose(); },
	};
}

for (const scenario of ["assigned task", "auto-claimed task", "pending DM batch", "plan approved", "plan rejected"] as const) {
	await test(`${scenario}: normal delivery survives Pi busy state`, async () => {
		const plan = scenario.startsWith("plan ");
		const h = await harness(scenario === "auto-claimed task", plan);
		try {
			if (scenario !== "pending DM batch") {
				const task = await createTask(h.teamDir, "tasks", {
					subject: "Delivery sentinel", description: "Offline delivery regression",
					...(scenario === "auto-claimed task" ? {} : { owner: "worker" }),
				});
				if (scenario !== "auto-claimed task") {
					await mailbox(h.teamDir, JSON.stringify({ type: "task_assignment", taskId: task.id }), "tasks");
				}
			}
			if (scenario === "pending DM batch") {
				await mailbox(h.teamDir, "first normal message");
				await mailbox(h.teamDir, "second normal message");
			}
			await h.emit("session_start");
			await waitFor(() => h.deliveries.length > 0, "initial worker delivery");
			if (plan) {
				await h.emit("agent_start");
				await h.emit("agent_end");
				const messages = await popUnreadMessages(h.teamDir, TEAM_MAILBOX_NS, "lead");
				const request = messages.map((m) => JSON.parse(m.text) as Record<string, unknown>)
					.find((m) => m.type === "plan_approval_request");
				assert.ok(request?.requestId, "worker emitted a real plan approval request");
				await mailbox(h.teamDir, JSON.stringify({
					type: scenario === "plan approved" ? "plan_approved" : "plan_rejected",
					requestId: request.requestId, from: "lead", feedback: "Add verification",
				}));
				await waitFor(() => h.deliveries.length === 2, "plan response delivery");
			}
			const delivery = h.deliveries.at(-1);
			assert.equal(delivery?.options?.deliverAs, "followUp");
			assert.ok(delivery && h.accepted.includes(delivery), "busy Pi accepted the message");
			if (scenario === "pending DM batch") {
				assert.match(JSON.stringify(delivery.content), /first normal message.*second normal message/);
			} else if (!plan) {
				assert.match(String(delivery.content), /Delivery sentinel/);
				assert.equal((await getTask(h.teamDir, "tasks", "1"))?.status, "in_progress");
			} else {
				assert.match(String(delivery.content), scenario === "plan approved" ? /approved/ : /Add verification/);
			}
		} finally { await h.dispose(); }
	});
}

await test("idle normal messages still start work; urgent streaming messages still steer", async () => {
	const h = await harness();
	try {
		h.setBusy(false);
		await h.emit("session_start");
		await mailbox(h.teamDir, "idle message");
		await waitFor(() => h.accepted.length === 1, "idle DM");
		assert.equal(h.accepted[0]?.options?.deliverAs, "followUp");
		h.setBusy(true);
		await h.emit("agent_start");
		await mailbox(h.teamDir, "urgent sentinel", TEAM_MAILBOX_NS, true);
		await waitFor(() => h.accepted.length === 2, "urgent DM");
		assert.equal(h.accepted[1]?.options?.deliverAs, "steer");
		assert.match(String(h.accepted[1]?.content), /urgent sentinel/);
	} finally { await h.dispose(); }
});

await test("real Pi SDK: loaded extension queues and consumes mailbox DM while internally busy", async () => {
	const env = await environment();
	let releaseStart = () => {};
	const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
	let enteredStart = false;
	let modelTurns = 0;
	const errors: string[] = [];
	const authStorage = AuthStorage.inMemory();
	const registry = ModelRegistry.create(authStorage, path.join(env.root, "models.json"));
	registry.registerProvider("worker-delivery-local", {
		api: "worker-delivery-local", baseUrl: "http://unused.invalid", apiKey: "offline-test-placeholder",
		models: [{ id: "fake", name: "Offline deterministic model", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 128 }],
		streamSimple(model) {
			modelTurns += 1;
			const stream = createAssistantMessageEventStream();
			void gate.then(() => stream.push({ type: "done", reason: "stop", message: {
				role: "assistant", content: [{ type: "text", text: "Offline acknowledgement" }],
				api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			} }));
			return stream;
		},
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: env.root, agentDir: env.root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/teams/index.ts", import.meta.url))],
		extensionFactories: [(pi) => {
			// Keep the real core busy before the worker receives agent_start. This
			// deterministically reproduces the optimistic worker/core state mismatch.
			pi.on("agent_start", async () => { enteredStart = true; await gate; });
		}],
		// Inline factories are appended after file extensions; run the gate first.
		extensionsOverride: (result) => ({ ...result, extensions: [...result.extensions].reverse() }),
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let prompt: Promise<void> | undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const model = registry.find("worker-delivery-local", "fake");
		assert.ok(model);
		({ session } = await createAgentSession({ cwd: env.root, agentDir: env.root, authStorage,
			modelRegistry: registry, model, settingsManager, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(env.root), tools: [] }));
		await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
		prompt = session.prompt("Initial held turn");
		await waitFor(() => enteredStart, "real Pi agent_start gate");
		assert.equal(session.isStreaming, true);
		await mailbox(env.teamDir, "real-Pi normal delivery sentinel");
		const activeSession = session;
		await waitFor(() => {
			assert.deepEqual(errors, [], "no asynchronous extension delivery errors");
			return activeSession.getFollowUpMessages().some((text) => text.includes("real-Pi normal delivery sentinel"));
		}, "real Pi follow-up queue");
		assert.deepEqual(session.getSteeringMessages(), []);
		releaseStart();
		await prompt;
		await waitFor(() => activeSession.messages.some((message) => message.role === "user"
			&& JSON.stringify(message.content).includes("real-Pi normal delivery sentinel")), "queued DM consumed");
		assert.equal(modelTurns, 2, "fake provider completed initial and follow-up turns");
		assert.equal(session.messages.at(-1)?.role, "assistant");
		assert.deepEqual(session.getFollowUpMessages(), []);
		assert.deepEqual(errors, []);
		console.log("REAL PI PASS: extension loaded; busy DM queued as followUp, consumed without network/model fees");
	} finally {
		releaseStart();
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			await prompt?.catch(() => {});
			session.dispose();
		}
		registry.unregisterProvider("worker-delivery-local");
		await env.dispose();
	}
});
