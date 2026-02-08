/**
 * Shared name sanitization.
 *
 * Must be stable across leader/worker/mailbox so file paths and mailbox ids match.
 */
export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Pool of person names for auto-generated comrades (soviet style). */
const COMRADE_NAMES = [
	"ivan",
	"natasha",
	"boris",
	"olga",
	"dmitri",
	"katya",
	"sergei",
	"anya",
	"nikolai",
	"mila",
	"viktor",
	"lena",
	"pavel",
	"zoya",
	"alexei",
	"daria",
	"yuri",
	"vera",
	"andrei",
	"sonya",
	"maxim",
	"nina",
	"roman",
	"tanya",
	"leon",
	"irina",
	"oleg",
	"nadia",
	"artem",
	"lydia",
];

/**
 * Pick `count` names from the pool that aren't already taken.
 * Falls back to `<name>-2`, `<name>-3` etc. if pool is exhausted.
 */
export function pickComradeNames(count: number, taken: ReadonlySet<string>): string[] {
	const available = COMRADE_NAMES.filter((n) => !taken.has(n));
	const picked: string[] = [];

	for (let i = 0; i < count; i++) {
		const avail = available[i];
		if (avail !== undefined) {
			picked.push(avail);
			continue;
		}

		// Exhaust pool: append suffix to cycle through names again
		const base = COMRADE_NAMES[i % COMRADE_NAMES.length] ?? "comrade";
		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (taken.has(candidate) || picked.includes(candidate)) {
			suffix++;
			candidate = `${base}-${suffix}`;
		}
		picked.push(candidate);
	}

	return picked;
}

/**
 * Deterministic default names for normal style.
 * Produces agent1, agent2, ... skipping taken.
 */
export function pickAgentNames(count: number, taken: ReadonlySet<string>): string[] {
	const picked: string[] = [];
	let i = 1;
	while (picked.length < count) {
		const candidate = `agent${i}`;
		i++;
		if (taken.has(candidate) || picked.includes(candidate)) continue;
		picked.push(candidate);
	}
	return picked;
}
