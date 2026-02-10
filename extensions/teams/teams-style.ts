import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeName, COMRADE_NAME_POOL, PIRATE_NAME_POOL } from "./names.js";
import { getTeamsStylesDir } from "./paths.js";

/**
 * Teams UI style id.
 *
 * Built-in styles ship with the extension. Users can add custom styles by
 * creating JSON files under `${getTeamsStylesDir()}`.
 */
export type TeamsStyle = string;

export const TEAMS_STYLES = ["normal", "soviet", "pirate"] as const;
export type BuiltinTeamsStyle = (typeof TEAMS_STYLES)[number];

export type TeamsStrings = {
	leaderTitle: string;
	leaderControlTitle: string;
	memberTitle: string;
	memberPrefix: string;
	teamNoun: string;
	joinedVerb: string;
	leftVerb: string;
	killedVerb: string;

	// Lifecycle copy (all shown as "<member> <verb...>")
	shutdownRequestedVerb: string;
	shutdownCompletedVerb: string;
	shutdownRefusedVerb: string;
	abortRequestedVerb: string;

	// Templates (supports {members} and/or {count})
	noMembersToShutdown: string;
	shutdownAllPrompt: string;
	teamEndedAllStopped: string;
};

export type TeamsAutoNameStrategy =
	| { kind: "agent" }
	| { kind: "pool"; pool: readonly string[]; fallbackBase: string };

export type TeamsNamingRules = {
	/** If true, `/team spawn` requires an explicit name. */
	requireExplicitSpawnName: boolean;
	/** Default naming strategy for auto-spawn (e.g. tool-driven). */
	autoNameStrategy: TeamsAutoNameStrategy;
};

export type TeamsStyleDefinition = {
	id: TeamsStyle;
	strings: TeamsStrings;
	naming: TeamsNamingRules;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function formatTeamsTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => vars[key] ?? "");
}

export function normalizeTeamsStyleId(raw: unknown): TeamsStyle | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const sanitized = sanitizeName(trimmed).toLowerCase();
	return sanitized ? sanitized : null;
}

export function getTeamsStyleFromEnv(env: NodeJS.ProcessEnv = process.env): TeamsStyle {
	return normalizeTeamsStyleId(env.PI_TEAMS_STYLE) ?? "normal";
}

function builtinStyle(id: BuiltinTeamsStyle): TeamsStyleDefinition {
	if (id === "soviet") {
		return {
			id,
			strings: {
				leaderTitle: "Chairman",
				leaderControlTitle: "Chairman (control)",
				memberTitle: "Comrade",
				memberPrefix: "Comrade ",
				teamNoun: "Party",
				joinedVerb: "has joined the Party",
				leftVerb: "has left the Party",
				killedVerb: "sent to the gulag",

				shutdownRequestedVerb: "was asked to stand down",
				shutdownCompletedVerb: "stood down",
				shutdownRefusedVerb: "refused to comply",
				abortRequestedVerb: "was ordered to stop",

				noMembersToShutdown: "No {members} to shut down",
				shutdownAllPrompt: "Stop all {count} {members}?",
				teamEndedAllStopped: "Team ended: all {members} stopped (leader session remains active)",
			},
			naming: {
				requireExplicitSpawnName: false,
				autoNameStrategy: { kind: "pool", pool: COMRADE_NAME_POOL, fallbackBase: "comrade" },
			},
		};
	}
	if (id === "pirate") {
		return {
			id,
			strings: {
				leaderTitle: "Captain",
				leaderControlTitle: "Captain (control)",
				memberTitle: "Matey",
				memberPrefix: "Matey ",
				teamNoun: "crew",
				joinedVerb: "joined the crew",
				leftVerb: "abandoned ship",
				killedVerb: "walked the plank",

				shutdownRequestedVerb: "was ordered to strike the colors",
				shutdownCompletedVerb: "struck their colors",
				shutdownRefusedVerb: "defied the captain",
				abortRequestedVerb: "was ordered to belay that",

				noMembersToShutdown: "No {members} to send below decks",
				shutdownAllPrompt: "Dismiss all {count} {members}?",
				teamEndedAllStopped: "Crew dismissed: all {members} struck their colors (leader session remains active)",
			},
			naming: {
				requireExplicitSpawnName: false,
				autoNameStrategy: { kind: "pool", pool: PIRATE_NAME_POOL, fallbackBase: "matey" },
			},
		};
	}

	// normal
	return {
		id,
		strings: {
			leaderTitle: "Team leader",
			leaderControlTitle: "Leader (control)",
			memberTitle: "Teammate",
			memberPrefix: "Teammate ",
			teamNoun: "team",
			joinedVerb: "joined the team",
			leftVerb: "left the team",
			killedVerb: "stopped",

			shutdownRequestedVerb: "was asked to shut down",
			shutdownCompletedVerb: "shut down",
			shutdownRefusedVerb: "refused to shut down",
			abortRequestedVerb: "was asked to stop",

			noMembersToShutdown: "No {members} to shut down",
			shutdownAllPrompt: "Stop all {count} {members}?",
			teamEndedAllStopped: "Team ended: all {members} stopped (leader session remains active)",
		},
		naming: {
			requireExplicitSpawnName: true,
			autoNameStrategy: { kind: "agent" },
		},
	};
}

const BUILTINS: Record<BuiltinTeamsStyle, TeamsStyleDefinition> = {
	normal: builtinStyle("normal"),
	soviet: builtinStyle("soviet"),
	pirate: builtinStyle("pirate"),
};

function isBuiltinStyleId(id: TeamsStyle): id is BuiltinTeamsStyle {
	return (TEAMS_STYLES as readonly string[]).includes(id);
}

function getTeamsStyleConfigPath(styleId: TeamsStyle): string {
	return path.join(getTeamsStylesDir(), `${styleId}.json`);
}

type CustomCacheEntry =
	| { kind: "def"; def: TeamsStyleDefinition }
	| { kind: "error"; error: string }
	| { kind: "missing" };

const customCache = new Map<string, CustomCacheEntry>();

function coerceStringsPartial(obj: unknown): Partial<TeamsStrings> {
	if (!isRecord(obj)) return {};
	const out: Partial<TeamsStrings> = {};
	const keys: Array<keyof TeamsStrings> = [
		"leaderTitle",
		"leaderControlTitle",
		"memberTitle",
		"memberPrefix",
		"teamNoun",
		"joinedVerb",
		"leftVerb",
		"killedVerb",
		"shutdownRequestedVerb",
		"shutdownCompletedVerb",
		"shutdownRefusedVerb",
		"abortRequestedVerb",
		"noMembersToShutdown",
		"shutdownAllPrompt",
		"teamEndedAllStopped",
	];
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

function coerceAutoNameStrategy(obj: unknown): TeamsAutoNameStrategy | null {
	if (!isRecord(obj)) return null;
	const kind = obj.kind;
	if (kind === "agent") return { kind: "agent" };
	if (kind === "pool") {
		const poolRaw = obj.pool;
		if (!Array.isArray(poolRaw)) return null;
		const pool = poolRaw
			.filter((v): v is string => typeof v === "string")
			.map((s) => sanitizeName(s.trim()).toLowerCase())
			.filter((s) => s.length > 0);
		const fallbackBase =
			typeof obj.fallbackBase === "string"
				? sanitizeName(obj.fallbackBase.trim()).toLowerCase() || "member"
				: "member";
		return { kind: "pool", pool, fallbackBase };
	}
	return null;
}

function readCustomStyleDefinition(styleId: TeamsStyle): CustomCacheEntry {
	const file = getTeamsStyleConfigPath(styleId);
	try {
		if (!fs.existsSync(file)) return { kind: "missing" };
		const raw = fs.readFileSync(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return { kind: "error", error: `Style file is not an object: ${file}` };

		// Optional: base/extends
		const extendsRaw = normalizeTeamsStyleId(parsed.extends);
		const base: TeamsStyleDefinition =
			extendsRaw && isBuiltinStyleId(extendsRaw) ? BUILTINS[extendsRaw] : BUILTINS.normal;

		const stringsPatch = coerceStringsPartial(parsed.strings);
		const namingObj = parsed.naming;
		const requireExplicitSpawnName =
			isRecord(namingObj) && typeof namingObj.requireExplicitSpawnName === "boolean"
				? namingObj.requireExplicitSpawnName
				: base.naming.requireExplicitSpawnName;
		const autoNameStrategy =
			isRecord(namingObj) && "autoNameStrategy" in namingObj
				? coerceAutoNameStrategy((namingObj as Record<string, unknown>).autoNameStrategy) ?? base.naming.autoNameStrategy
				: base.naming.autoNameStrategy;

		const def: TeamsStyleDefinition = {
			id: styleId,
			strings: { ...base.strings, ...stringsPatch },
			naming: { requireExplicitSpawnName, autoNameStrategy },
		};
		return { kind: "def", def };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { kind: "error", error: `Failed to load style '${styleId}' from ${file}: ${msg}` };
	}
}

export function resolveTeamsStyleDefinition(styleIdRaw: TeamsStyle, opts?: { strict?: boolean }): TeamsStyleDefinition {
	const strict = opts?.strict === true;
	const styleId = normalizeTeamsStyleId(styleIdRaw) ?? "normal";

	if (isBuiltinStyleId(styleId)) return BUILTINS[styleId];

	const cached = customCache.get(styleId);
	const entry = cached ?? readCustomStyleDefinition(styleId);
	if (!cached) customCache.set(styleId, entry);

	if (entry.kind === "def") return entry.def;
	if (strict) {
		if (entry.kind === "missing") {
			throw new Error(
				`Unknown teams style: ${styleId}. Create ${getTeamsStyleConfigPath(styleId)} or use one of: ${TEAMS_STYLES.join(", ")}`,
			);
		}
		throw new Error(entry.error);
	}

	return BUILTINS.normal;
}

export function getTeamsStrings(style: TeamsStyle): TeamsStrings {
	return resolveTeamsStyleDefinition(style).strings;
}

export function getTeamsNamingRules(style: TeamsStyle): TeamsNamingRules {
	return resolveTeamsStyleDefinition(style).naming;
}

export function listAvailableTeamsStyles(): { dir: string; builtins: readonly string[]; customs: string[]; all: string[] } {
	const dir = getTeamsStylesDir();
	let customs: string[] = [];
	try {
		if (fs.existsSync(dir)) {
			customs = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -".json".length))
				.map((id) => normalizeTeamsStyleId(id))
				.filter((id): id is string => id !== null);
		}
	} catch {
		customs = [];
	}

	const builtins = TEAMS_STYLES as readonly string[];
	const all = Array.from(new Set([...builtins, ...customs])).sort();
	return { dir, builtins, customs, all };
}

export function formatMemberDisplayName(style: TeamsStyle, name: string): string {
	const s = getTeamsStrings(style);
	return s.memberPrefix ? `${s.memberPrefix}${name}` : name;
}
