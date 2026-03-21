import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { pickAgentNames, pickNamesFromPool } from "./names.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsNamingRules, getTeamsStrings } from "./teams-style.js";
import type { ContextMode, WorkspaceMode, SpawnTeammateFn } from "./spawn-types.js";

function isThinkingLevel(v: string): v is ThinkingLevel {
	switch (v) {
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return true;
		default:
			return false;
	}
}

export async function handleTeamSpawnCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teammates: Map<string, TeammateRpc>;
	style: TeamsStyle;
	spawnTeammate: SpawnTeammateFn;
}): Promise<void> {
	const { ctx, rest, teammates, style, spawnTeammate } = opts;
	const strings = getTeamsStrings(style);

	// Parse flags from any position
	let nameRaw: string | undefined;
	let mode: ContextMode = "fresh";
	let workspaceMode: WorkspaceMode = "shared";
	let planRequired = false;
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;

	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (!a) continue;

		if (a === "fresh" || a === "branch") {
			mode = a;
			continue;
		}
		if (a === "shared" || a === "worktree") {
			workspaceMode = a;
			continue;
		}
		if (a === "plan") {
			planRequired = true;
			continue;
		}

		if (a === "--model") {
			const next = rest[i + 1];
			if (!next) {
				ctx.ui.notify("Usage: /team spawn <name> [fresh|branch] [shared|worktree] [plan] [--model <provider>/<modelId>] [--thinking <level>]", "error");
				return;
			}
			model = next;
			i++;
			continue;
		}
		if (a.startsWith("--model=")) {
			model = a.slice("--model=".length);
			continue;
		}

		if (a === "--thinking") {
			const next = rest[i + 1];
			if (!next) {
				ctx.ui.notify("Usage: /team spawn <name> [fresh|branch] [shared|worktree] [plan] [--model <provider>/<modelId>] [--thinking <level>]", "error");
				return;
			}
			if (!isThinkingLevel(next)) {
				ctx.ui.notify(
					`Invalid thinking level '${next}'. Valid values: off, minimal, low, medium, high, xhigh`,
					"error",
				);
				return;
			}
			thinking = next;
			i++;
			continue;
		}
		if (a.startsWith("--thinking=")) {
			const next = a.slice("--thinking=".length);
			if (!isThinkingLevel(next)) {
				ctx.ui.notify(
					`Invalid thinking level '${next}'. Valid values: off, minimal, low, medium, high, xhigh`,
					"error",
				);
				return;
			}
			thinking = next;
			continue;
		}

		if (!nameRaw && !a.startsWith("--")) nameRaw = a;
	}

	model = model?.trim();
	if (model === "") model = undefined;

	// Auto-pick a name when the current style allows it.
	if (!nameRaw) {
		const naming = getTeamsNamingRules(style);
		if (naming.requireExplicitSpawnName) {
			ctx.ui.notify(
				"Usage: /team spawn <name> [fresh|branch] [shared|worktree] [plan] [--model <provider>/<modelId>] [--thinking <level>]",
				"error",
			);
			return;
		}

		const taken = new Set(teammates.keys());
		const picked = (() => {
			if (naming.autoNameStrategy.kind === "agent") return pickAgentNames(1, taken).at(0);
			return pickNamesFromPool({
				pool: naming.autoNameStrategy.pool,
				count: 1,
				taken,
				fallbackBase: naming.autoNameStrategy.fallbackBase,
			}).at(0);
		})();
		if (!picked) {
			ctx.ui.notify(`Failed to pick a ${strings.memberTitle.toLowerCase()} name`, "error");
			return;
		}
		nameRaw = picked;
	}

	const res = await spawnTeammate(ctx, { name: nameRaw, mode, workspaceMode, planRequired, model, thinking });
	if (!res.ok) {
		ctx.ui.notify(res.error, "error");
		return;
	}

	for (const w of res.warnings) ctx.ui.notify(w, "warning");
	const displayName = formatMemberDisplayName(style, res.name);
	const extras: string[] = [];
	if (res.model) extras.push(res.model);
	if (res.thinking) extras.push(`thinking:${res.thinking}`);
	const extrasStr = extras.length > 0 ? ` \u00b7 ${extras.join(" \u00b7 ")}` : "";
	ctx.ui.notify(
		`${displayName} ${strings.joinedVerb} (${res.mode}${res.note ? ", " + res.note : ""} \u00b7 ${res.workspaceMode}${extrasStr})`,
		"info",
	);
}
