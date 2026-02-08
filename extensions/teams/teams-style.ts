export type TeamsStyle = "normal" | "soviet";

export const TEAMS_STYLES: readonly TeamsStyle[] = ["normal", "soviet"] as const;

function coerceTeamsStyle(v: unknown): TeamsStyle | null {
	return v === "normal" || v === "soviet" ? v : null;
}

/**
 * Resolve teams UI style.
 *
 * Priority:
 * 1) PI_TEAMS_STYLE env
 * 2) default "normal"
 */
export function getTeamsStyleFromEnv(env: NodeJS.ProcessEnv = process.env): TeamsStyle {
	const raw = env.PI_TEAMS_STYLE;
	const coerced = coerceTeamsStyle(raw);
	return coerced ?? "normal";
}

export function isSovietStyle(style: TeamsStyle): boolean {
	return style === "soviet";
}

export type TeamsStrings = {
	leaderTitle: string;
	memberTitle: string;
	memberPrefix: string;
	teamNoun: string;
	joinedVerb: string;
	leftVerb: string;
	killedVerb: string;
};

export function getTeamsStrings(style: TeamsStyle): TeamsStrings {
	if (style === "soviet") {
		return {
			leaderTitle: "Chairman",
			memberTitle: "Comrade",
			memberPrefix: "Comrade ",
			teamNoun: "Party",
			joinedVerb: "has joined the Party",
			leftVerb: "has left the Party",
			killedVerb: "sent to the gulag",
		};
	}
	return {
		leaderTitle: "Team leader",
		memberTitle: "Teammate",
		memberPrefix: "Teammate ",
		teamNoun: "team",
		joinedVerb: "joined the team",
		leftVerb: "left the team",
		killedVerb: "stopped",
	};
}

export function formatMemberDisplayName(style: TeamsStyle, name: string): string {
	const s = getTeamsStrings(style);
	return s.memberPrefix ? `${s.memberPrefix}${name}` : name;
}
