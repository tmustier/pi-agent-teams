export const TEAM_MAILBOX_NS = "team";

function safeParseJson(text: string): unknown | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		return null;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

// Leader-side inbox messages

export function isIdleNotification(
	text: string,
): {
	from: string;
	timestamp?: string;
	completedTaskId?: string;
	completedStatus?: string;
	failureReason?: string;
} | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "idle_notification") return null;
	return {
		from: getString(obj, "from") ?? "unknown",
		timestamp: getString(obj, "timestamp"),
		completedTaskId: getString(obj, "completedTaskId"),
		completedStatus: getString(obj, "completedStatus"),
		failureReason: getString(obj, "failureReason"),
	};
}

export function isShutdownApproved(
	text: string,
): {
	from: string;
	requestId: string;
	timestamp?: string;
} | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "shutdown_approved") return null;
	const requestId = getString(obj, "requestId");
	if (!requestId) return null;
	return {
		from: getString(obj, "from") ?? "unknown",
		requestId,
		timestamp: getString(obj, "timestamp"),
	};
}

export function isShutdownRejected(
	text: string,
): {
	from: string;
	requestId: string;
	reason: string;
	timestamp?: string;
} | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "shutdown_rejected") return null;
	const requestId = getString(obj, "requestId");
	if (!requestId) return null;
	return {
		from: getString(obj, "from") ?? "unknown",
		requestId,
		reason: getString(obj, "reason") ?? "",
		timestamp: getString(obj, "timestamp"),
	};
}

export function isPlanApprovalRequest(
	text: string,
): {
	requestId: string;
	from: string;
	plan: string;
	taskId?: string;
	timestamp?: string;
} | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "plan_approval_request") return null;
	const requestId = getString(obj, "requestId");
	const from = getString(obj, "from");
	const plan = getString(obj, "plan");
	if (!requestId || !from || !plan) return null;
	return {
		requestId,
		from,
		plan,
		taskId: getString(obj, "taskId"),
		timestamp: getString(obj, "timestamp"),
	};
}

export function isPeerDmSent(
	text: string,
): {
	from: string;
	to: string;
	summary: string;
	timestamp?: string;
} | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "peer_dm_sent") return null;
	const from = getString(obj, "from");
	const to = getString(obj, "to");
	const summary = getString(obj, "summary");
	if (!from || !to || !summary) return null;
	return {
		from,
		to,
		summary,
		timestamp: getString(obj, "timestamp"),
	};
}

// Worker-side inbox messages

export function isTaskAssignmentMessage(
	text: string,
): { taskId: string; subject?: string; description?: string; assignedBy?: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "task_assignment") return null;
	const taskId = getString(obj, "taskId");
	if (!taskId) return null;
	return {
		taskId,
		subject: getString(obj, "subject"),
		description: getString(obj, "description"),
		assignedBy: getString(obj, "assignedBy"),
	};
}

export function isShutdownRequestMessage(
	text: string,
): { requestId: string; from?: string; reason?: string; timestamp?: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "shutdown_request") return null;
	const requestId = getString(obj, "requestId");
	if (!requestId) return null;
	return {
		requestId,
		from: getString(obj, "from"),
		reason: getString(obj, "reason"),
		timestamp: getString(obj, "timestamp"),
	};
}

export function isSetSessionNameMessage(text: string): { name: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "set_session_name") return null;
	const name = getString(obj, "name");
	if (!name) return null;
	return { name };
}

export function isAbortRequestMessage(
	text: string,
): { requestId: string; from?: string; taskId?: string; reason?: string; timestamp?: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "abort_request") return null;
	const requestId = getString(obj, "requestId");
	if (!requestId) return null;
	return {
		requestId,
		from: getString(obj, "from"),
		taskId: getString(obj, "taskId"),
		reason: getString(obj, "reason"),
		timestamp: getString(obj, "timestamp"),
	};
}

export function isPlanApprovedMessage(text: string): { requestId: string; from: string; timestamp: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "plan_approved") return null;
	const requestId = getString(obj, "requestId");
	const from = getString(obj, "from");
	if (!requestId || !from) return null;
	return {
		requestId,
		from,
		timestamp: getString(obj, "timestamp") ?? "",
	};
}

export function isPlanRejectedMessage(
	text: string,
): { requestId: string; from: string; feedback: string; timestamp: string } | null {
	const obj = safeParseJson(text);
	if (!isRecord(obj)) return null;
	if (getString(obj, "type") !== "plan_rejected") return null;
	const requestId = getString(obj, "requestId");
	const from = getString(obj, "from");
	if (!requestId || !from) return null;
	return {
		requestId,
		from,
		feedback: getString(obj, "feedback") ?? "",
		timestamp: getString(obj, "timestamp") ?? "",
	};
}
