import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TeamAttachClaimHeartbeatResult } from "./team-attach-claim.js";

interface SessionManagerWithHeader {
	getHeader(): { parentSession?: string } | null;
}

export function getParentSessionId(sessionManager: SessionManagerWithHeader): string | null {
	const parentSessionPath = sessionManager.getHeader()?.parentSession;
	if (!parentSessionPath) return null;
	try {
		return SessionManager.open(parentSessionPath).getSessionId();
	} catch {
		return null;
	}
}

export function shouldSilenceInheritedParentAttachClaimWarning(opts: {
	currentTeamId: string;
	parentSessionId: string | null;
	result: TeamAttachClaimHeartbeatResult;
}): boolean {
	return opts.result === "missing" && opts.parentSessionId !== null && opts.currentTeamId === opts.parentSessionId;
}
