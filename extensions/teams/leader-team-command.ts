import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getTeamDir } from "./paths.js";
import {
	handleTeamEnvCommand,
	handleTeamIdCommand,
	handleTeamListCommand,
	handleTeamStatusCommand,
} from "./leader-info-commands.js";
import { handleTeamAttachCommand, handleTeamDetachCommand } from "./leader-attach-commands.js";
import {
	handleTeamCleanupCommand,
	handleTeamDelegateCommand,
	handleTeamDoneCommand,
	handleTeamGcCommand,
	handleTeamKillCommand,
	handleTeamPruneCommand,
	handleTeamShutdownCommand,
	handleTeamStopCommand,
	handleTeamStyleCommand,
} from "./leader-lifecycle-commands.js";
import {
	handleTeamBroadcastCommand,
	handleTeamDmCommand,
	handleTeamSendCommand,
	handleTeamSteerCommand,
} from "./leader-messaging-commands.js";
import { handleTeamPlanCommand } from "./leader-plan-commands.js";
import { handleTeamSpawnCommand } from "./leader-spawn-command.js";
import { handleTeamTaskCommand } from "./leader-task-commands.js";
import type { SpawnTeammateFn } from "./spawn-types.js";
import type { TeamConfig } from "./team-config.js";
import type { TeamTask } from "./task-store.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { ActivityTracker } from "./activity-tracker.js";
import type { TeamsStyle } from "./teams-style.js";

const TEAM_HELP_TEXT = [
	"Usage:",
	"  /team id",
	"  /team env <name>",
	"  /team attach list",
	"  /team attach <teamId> [--claim]",
	"  /team detach",
	"  /team spawn <name> [fresh|branch] [shared|worktree] [plan] [--model <provider>/<modelId>] [--thinking <level>]",
	"  /team status [name]  # real-time worker state (stall detection, time in state, activity)",
	"  /team panel",
	"  /team send <name> <msg...>",
	"  /team dm <name> [--urgent] <msg...>",
	"  /team broadcast [--urgent] <msg...>",
	"  /team steer <name> <msg...>",
	"  /team stop <name> [reason...]",
	"  /team kill <name>",
	"  /team shutdown",
	"  /team shutdown <name> [reason...]",
	"  /team delegate [on|off]",
	"  /team style",
	"  /team style list",
	"  /team style <name>",
	"  /team style init <name> [extends <base>]",
	"  /team plan approve <name>",
	"  /team plan reject <name> [feedback...]",
	"  /team done [--force]  # end run: stop teammates + hide widget",
	"  /team cleanup [--force]",
	"  /team gc [--dry-run] [--force] [--max-age-hours=N]  # remove old team dirs",
	"  /team prune [--all]  # hide stale manual teammates (mark offline)",
	"  /team task add <text...>",
	"  /team task assign <id> <agent>",
	"  /team task unassign <id>",
	"  /team task list",
	"  /team task clear [completed|all] [--force]",
	"  /team task show <id>",
	"  /team task dep add <id> <depId>",
	"  /team task dep rm <id> <depId>",
	"  /team task dep ls <id>",
	"  /team task use <taskListId>",
].join("\n");

export function getTeamHelpText(): string {
	return TEAM_HELP_TEXT;
}

export async function handleTeamCommand(opts: {
	args: string;
	ctx: ExtensionCommandContext;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	getTracker: () => ActivityTracker;
	getTasks: () => TeamTask[];
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	hideWidget: () => void;
	restoreWidget: () => void;
	getTaskListId: () => string | null;
	setTaskListId: (id: string) => void;
	getActiveTeamId: () => string;
	setActiveTeamId: (teamId: string) => void;
	pendingPlanApprovals: Map<string, { requestId: string; name: string; taskId?: string }>;
	getDelegateMode: () => boolean;
	setDelegateMode: (next: boolean) => void;
	getStyle: () => TeamsStyle;
	setStyle: (next: TeamsStyle) => void;
	spawnTeammate: SpawnTeammateFn;
	openWidget: (ctx: ExtensionCommandContext) => Promise<void>;
	getTeamsExtensionEntryPath: () => string | null;
	shellQuote: (v: string) => string;
	getCurrentCtx: () => ExtensionContext | null;
	stopAllTeammates: (ctx: ExtensionContext, reason: string) => Promise<void>;
}): Promise<void> {
	const {
		args,
		ctx,
		teammates,
		getTeamConfig,
		getTracker,
		getTasks,
		refreshTasks,
		renderWidget,
		hideWidget,
		restoreWidget,
		getTaskListId,
		setTaskListId,
		getActiveTeamId,
		setActiveTeamId,
		pendingPlanApprovals,
		getDelegateMode,
		setDelegateMode,
		getStyle,
		setStyle,
		spawnTeammate,
		openWidget,
		getTeamsExtensionEntryPath,
		shellQuote,
		getCurrentCtx,
		stopAllTeammates,
	} = opts;

	const style = getStyle();
	const activeTeamId = getActiveTeamId();
	const leadName = getTeamConfig()?.leadName ?? "team-lead";
	const taskListId = getTaskListId();

	const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
	const [sub, ...rest] = parts;
	if (!sub || sub === "help") {
		ctx.ui.notify(getTeamHelpText(), "info");
		return;
	}

	type TeamSubcommandHandler = () => Promise<void>;
	const handlers: Record<string, TeamSubcommandHandler> = {
		list: async () => {
			await handleTeamListCommand({
				ctx,
				teammates,
				getTeamConfig,
				getTracker,
				style,
				refreshTasks,
				renderWidget,
			});
		},

		id: async () => {
			await handleTeamIdCommand({
				ctx,
				teamId: activeTeamId,
				taskListId,
				leadName,
				style,
			});
		},

		env: async () => {
			await handleTeamEnvCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				taskListId,
				leadName,
				style,
				getTeamsExtensionEntryPath,
				shellQuote,
			});
		},

		attach: async () => {
			await handleTeamAttachCommand({
				ctx,
				rest,
				defaultTeamId: ctx.sessionManager.getSessionId(),
				teammates,
				getActiveTeamId,
				setActiveTeamId,
				setStyle,
				setTaskListId,
				refreshTasks,
				renderWidget,
				restoreWidget,
			});
		},

		detach: async () => {
			await handleTeamDetachCommand({
				ctx,
				defaultTeamId: ctx.sessionManager.getSessionId(),
				teammates,
				getActiveTeamId,
				setActiveTeamId,
				setTaskListId,
				refreshTasks,
				renderWidget,
				restoreWidget,
			});
		},

		done: async () => {
			await handleTeamDoneCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				getTeamConfig,
				leadName,
				style,
				stopAllTeammates,
				refreshTasks,
				getTasks,
				hideWidget,
			});
		},

		cleanup: async () => {
			await handleTeamCleanupCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				refreshTasks,
				getTasks,
				renderWidget,
				style,
			});
		},

		gc: async () => {
			await handleTeamGcCommand({ ctx, rest });
		},

		prune: async () => {
			await handleTeamPruneCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				getTeamConfig,
				refreshTasks,
				getTasks,
				style,
				renderWidget,
			});
		},

		delegate: async () => {
			await handleTeamDelegateCommand({
				ctx,
				rest,
				getDelegateMode,
				setDelegateMode,
				renderWidget,
			});
		},

		shutdown: async () => {
			await handleTeamShutdownCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				getTeamConfig,
				leadName,
				style,
				getCurrentCtx,
				getActiveTeamId,
				stopAllTeammates,
				refreshTasks,
				getTasks,
				renderWidget,
			});
		},

		spawn: async () => {
			await handleTeamSpawnCommand({ ctx, rest, teammates, style, spawnTeammate });
		},

		status: async () => {
			await handleTeamStatusCommand({
				ctx,
				rest,
				teammates,
				getTeamConfig,
				getTracker,
				teamId: activeTeamId,
				taskListId,
				style,
			});
		},

		style: async () => {
			const teamDir = getTeamDir(activeTeamId);
			await handleTeamStyleCommand({
				ctx,
				rest,
				teamDir,
				getStyle,
				setStyle,
				refreshTasks,
				renderWidget,
			});
		},

		panel: async () => {
			await openWidget(ctx);
		},

		send: async () => {
			await handleTeamSendCommand({
				ctx,
				rest,
				teammates,
				style,
				renderWidget,
			});
		},

		steer: async () => {
			await handleTeamSteerCommand({
				ctx,
				rest,
				teammates,
				style,
				renderWidget,
			});
		},

		stop: async () => {
			await handleTeamStopCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				leadName,
				style,
				refreshTasks,
				getTasks,
				renderWidget,
			});
		},

		kill: async () => {
			await handleTeamKillCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				leadName,
				style,
				taskListId,
				refreshTasks,
				renderWidget,
			});
		},

		dm: async () => {
			await handleTeamDmCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				leadName,
				style,
			});
		},

		broadcast: async () => {
			await handleTeamBroadcastCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				teammates,
				leadName,
				style,
				refreshTasks,
				getTasks,
				getTaskListId,
			});
		},

		task: async () => {
			await handleTeamTaskCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				leadName,
				style,
				getTaskListId,
				setTaskListId,
				getTasks,
				refreshTasks,
				renderWidget,
			});
		},

		plan: async () => {
			await handleTeamPlanCommand({
				ctx,
				rest,
				teamId: activeTeamId,
				leadName,
				style,
				pendingPlanApprovals,
			});
		},
	};

	const normalizedSub = sub === "widget" ? "panel" : sub === "join" ? "attach" : sub;
	const handler = handlers[normalizedSub];
	if (!handler) {
		ctx.ui.notify(`Unknown subcommand: ${sub}`, "error");
		return;
	}
	await handler();
}
