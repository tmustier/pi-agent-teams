export const WORKER_COMMUNICATION_TOOLS = ["message_lead", "team_message"] as const;

export const WORKER_BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const WORKER_READ_ONLY_PLAN_TOOLS = ["read", "grep", "find", "ls", ...WORKER_COMMUNICATION_TOOLS] as const;

export function withWorkerCommunicationTools(activeTools: readonly string[] | null | undefined): string[] {
	const result = [...(activeTools ?? [])];
	for (const tool of WORKER_COMMUNICATION_TOOLS) {
		if (!result.includes(tool)) result.push(tool);
	}
	return result;
}

export function buildWorkerToolAllowlist(activeTools: readonly string[] | null | undefined): string[] {
	const builtIns = new Set<string>(WORKER_BUILT_IN_TOOLS);
	const inheritedBuiltIns = (activeTools ?? []).filter((tool) => builtIns.has(tool));
	return withWorkerCommunicationTools(inheritedBuiltIns);
}
