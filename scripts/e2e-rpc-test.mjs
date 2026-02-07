import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 120_000, pollMs = 200, label = "condition" } = {}) {
	const start = Date.now();
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (await fn()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
		await sleep(pollMs);
	}
}

function safeJsonParse(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function mkTempTeamsRootDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-root-"));
	return dir;
}

async function run() {
	const repoRoot = process.cwd();
	const extensionPath = path.join(repoRoot, "extensions/teams/index.ts");
	if (!fs.existsSync(extensionPath)) throw new Error(`Extension not found: ${extensionPath}`);

	const teamsRootDir = mkTempTeamsRootDir();
	console.log("teamsRootDir:", teamsRootDir);

	const env = {
		...process.env,
		// Keep the real PI agent dir for credentials/settings, but isolate Teams artifacts.
		PI_TEAMS_ROOT_DIR: teamsRootDir,
		// Ensure the leader runs in leader mode even when this script is executed from inside a worker.
		PI_TEAMS_WORKER: "0",
		PI_TEAMS_TEAM_ID: "",
		PI_TEAMS_AGENT_NAME: "",
		PI_TEAMS_TASK_LIST_ID: "",
		PI_TEAMS_LEAD_NAME: "",
		PI_TEAMS_AUTO_CLAIM: "",
	};

	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-tools",
		"--provider",
		"openai-codex",
		"--model",
		"gpt-5.1-codex-mini",
		"--thinking",
		"minimal",
		"--no-extensions",
		"-e",
		extensionPath,
	];

	const proc = spawn("pi", args, { env, stdio: ["pipe", "pipe", "pipe"] });

	let stderr = "";
	proc.stderr.on("data", (d) => {
		stderr += d.toString();
	});

	const pending = new Map();
	let nextId = 1;

	const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
	let leaderSessionId = null;

	rl.on("line", (line) => {
		const obj = safeJsonParse(line);
		if (!obj) return;

		if (obj.type === "response") {
			if (obj.id && pending.has(obj.id)) {
				pending.get(obj.id).resolve(obj);
				pending.delete(obj.id);
			}
			return;
		}

		if (obj.type === "extension_ui_request") {
			// Useful visibility in CI/logs
			if (obj.method === "notify") {
				console.log(`[notify:${obj.notifyType ?? "info"}] ${obj.message}`);
			}
			return;
		}

		// Other agent events can be noisy; keep minimal.
		if (obj.type === "extension_error") {
			console.log(`[extension_error] ${obj.error}`);
		}
	});

	const send = (command) => {
		const id = command.id ?? `req-${nextId++}`;
		const full = { ...command, id };
		proc.stdin.write(JSON.stringify(full) + "\n");
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (!pending.has(id)) return;
				pending.delete(id);
				reject(new Error(`Timeout waiting for response: ${id} (${full.type})`));
			}, 30_000);
		});
	};

	try {
		// ---------------------------------------------------------------------
		// Get session id (used as teamId/taskListId)
		// ---------------------------------------------------------------------
		const stateResp = await send({ type: "get_state" });
		leaderSessionId = stateResp.data?.sessionId;
		if (!leaderSessionId) throw new Error(`No sessionId in get_state response: ${JSON.stringify(stateResp)}`);
		console.log("leaderSessionId:", leaderSessionId);

		let teamDir;
		let cfgPath;

		// ---------------------------------------------------------------------
		// Spawn worker
		// ---------------------------------------------------------------------
		await send({ type: "prompt", message: "/team spawn alice fresh" });

		// Discover the teamId directory (leader uses its sessionId as teamId, but RPC get_state may differ).
		await waitFor(
			() => {
				try {
					const dirs = fs
						.readdirSync(teamsRootDir, { withFileTypes: true })
						.filter((e) => e.isDirectory())
						.map((e) => e.name);
					return dirs.some((d) => fs.existsSync(path.join(teamsRootDir, d, "config.json")));
				} catch {
					return false;
				}
			},
			{ label: "team config created" },
		);

		const teamDirs = fs
			.readdirSync(teamsRootDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);

		const teamIdDir =
			teamDirs.find((d) => fs.existsSync(path.join(teamsRootDir, d, "config.json"))) ?? teamDirs.sort()[0];

		teamDir = path.join(teamsRootDir, teamIdDir);
		cfgPath = path.join(teamDir, "config.json");

		await waitFor(
			async () => {
				try {
					const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
					return Array.isArray(cfg.members) && cfg.members.some((m) => m.name === "alice" && m.status === "online");
				} catch {
					return false;
				}
			},
			{ label: "team config member alice online" },
		);
		console.log("OK: alice online in config.json");

		// ---------------------------------------------------------------------
		// Teammate session naming (leader-driven)
		// ---------------------------------------------------------------------
		await waitFor(
			async () => {
				try {
					const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
					const alice = cfg.members?.find((m) => m.name === "alice");
					return alice?.meta?.sessionName === "pi agent teams - comrade alice";
				} catch {
					return false;
				}
			},
			{ label: "alice sessionName recorded in config" },
		);
		console.log("OK: alice sessionName recorded in config");

		// ---------------------------------------------------------------------
		// Graceful teammate shutdown (mailbox handshake)
		// ---------------------------------------------------------------------
		await send({ type: "prompt", message: "/team shutdown alice e2e" });

		await waitFor(
			async () => {
				try {
					const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
					return Array.isArray(cfg.members) && cfg.members.some((m) => m.name === "alice" && m.status === "offline");
				} catch {
					return false;
				}
			},
			{ label: "alice offline after /team shutdown alice", timeoutMs: 60_000, pollMs: 500 },
		);
		console.log("OK: alice offline after /team shutdown alice");

		// ---------------------------------------------------------------------
		// Shutdown
		// ---------------------------------------------------------------------
		await send({ type: "prompt", message: "/team shutdown" });

		// RPC mode nuance: prompt is fire-and-forget. Extension commands run async,
		// but rpc-mode only checks the shutdownRequested flag after handling *another*
		// input line. Keep sending cheap commands until the process exits.
		const kickTimer = setInterval(() => {
			try {
				proc.stdin.write(JSON.stringify({ type: "get_state", id: `kick-${Date.now()}` }) + "\n");
			} catch {
				// ignore
			}
		}, 250);

		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Timeout waiting for pi to exit. stderr=${stderr}`));
			}, 30_000);

			proc.on("close", (code) => {
				clearInterval(kickTimer);
				clearTimeout(timeout);
				if (code === 0) resolve();
				else reject(new Error(`pi exited with code ${code}. stderr=${stderr}`));
			});
		});

		// Verify alice offline after shutdown
		try {
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
			const alice = cfg.members?.find((m) => m.name === "alice");
			if (alice) console.log("alice final status:", alice.status);
		} catch {
			// ignore
		}

		console.log("OK: e2e rpc test passed");
	} finally {
		try {
			rl.close();
		} catch {
			// ignore
		}
		try {
			proc.kill("SIGTERM");
		} catch {
			// ignore
		}
		try {
			fs.rmSync(teamsRootDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
