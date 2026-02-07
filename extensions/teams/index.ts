import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runLeader } from "./leader.js";
import { runWorker } from "./worker.js";

/**
 * pi-teams
 *
 * Two roles in one extension (Claude-style):
 * - Leader process: spawn teammates, manage task list + mailbox UI/commands
 * - Worker process: poll mailbox + auto-claim tasks from shared task list
 */

const IS_WORKER = process.env.PI_TEAMS_WORKER === "1";

export default function (pi: ExtensionAPI) {
	if (IS_WORKER) runWorker(pi);
	else runLeader(pi);
}
