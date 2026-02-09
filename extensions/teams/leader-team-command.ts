import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getTeamDir } from "./paths.js";
import {
	handleTeamEnvCommand,
	handleTeamIdCommand,
	handleTeamListCommand,
} from "./leader-info-commands.js";
import {
	handleTeamCleanupCommand,
	handleTeamDelegateCommand,
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
import type { TeamsStyle } from "./teams-style.js";

const TEAM_HELP_TEXT = [
	"Usage:",
	"  /team id",
	"  /team env <name>",
	"  /team spawn <name> [fresh|branch] [shared|worktree] [plan]",
	"  /team panel",
	"  /team send <name> <msg...>",
	"  /team dm <name> <msg...>",
	"  /team broadcast <msg...>",
	"  /team steer <name> <msg...>",
	"  /team stop <name> [reason...]",
	"  /team kill <name>",
	"  /team shutdown",
	"  /team shutdown <name> [reason...]",
	"  /team delegate [on|off]",
	"  /team plan approve <name>",
	"  /team plan reject <name> [feedback...]",
	"  /team cleanup [--force]",
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
	getTasks: () => TeamTask[];
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
	getTaskListId: () => string | null;
	setTaskListId: (id: string) => void;
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
		getTasks,
		refreshTasks,
		renderWidget,
		getTaskListId,
		setTaskListId,
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
	const leadName = getTeamConfig()?.leadName ?? "team-lead";
	const taskListId = getTaskListId();

	const [sub, ...rest] = args.trim().split(" ");
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
				style,
				refreshTasks,
				renderWidget,
			});
		},

		id: async () => {
			await handleTeamIdCommand({
				ctx,
				taskListId,
				leadName,
				style,
			});
		},

		env: async () => {
			await handleTeamEnvCommand({
				ctx,
				rest,
				taskListId,
				leadName,
				style,
				getTeamsExtensionEntryPath,
				shellQuote,
			});
		},

		cleanup: async () => {
			await handleTeamCleanupCommand({
				ctx,
				rest,
				teammates,
				refreshTasks,
				getTasks,
				renderWidget,
				style,
			});
		},

		prune: async () => {
			await handleTeamPruneCommand({
				ctx,
				rest,
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
				teammates,
				getTeamConfig,
				leadName,
				style,
				getCurrentCtx,
				stopAllTeammates,
				refreshTasks,
				getTasks,
				renderWidget,
			});
		},

		spawn: async () => {
			await handleTeamSpawnCommand({ ctx, rest, teammates, style, spawnTeammate });
		},

		style: async () => {
			const teamId = ctx.sessionManager.getSessionId();
			const teamDir = getTeamDir(teamId);
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
				leadName,
				style,
			});
		},

		broadcast: async () => {
			await handleTeamBroadcastCommand({
				ctx,
				rest,
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
				leadName,
				style,
				pendingPlanApprovals,
			});
		},
	};

	const normalizedSub = sub === "widget" ? "panel" : sub;
	const handler = handlers[normalizedSub];
	if (!handler) {
		ctx.ui.notify(`Unknown subcommand: ${sub}`, "error");
		return;
	}
	await handler();
}
