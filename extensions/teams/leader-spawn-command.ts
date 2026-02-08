import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ContextMode = "fresh" | "branch";
export type WorkspaceMode = "shared" | "worktree";

export type SpawnTeammateResult =
	| {
			ok: true;
			name: string;
			mode: ContextMode;
			workspaceMode: WorkspaceMode;
			note?: string;
			warnings: string[];
	  }
	| { ok: false; error: string };

export async function handleTeamSpawnCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	spawnTeammate: (
		ctx: ExtensionContext,
		opts: { name: string; mode?: ContextMode; workspaceMode?: WorkspaceMode; planRequired?: boolean },
	) => Promise<SpawnTeammateResult>;
}): Promise<void> {
	const { ctx, rest, spawnTeammate } = opts;

	const nameRaw = rest[0];
	const spawnArgs = rest.slice(1);

	let mode: ContextMode = "fresh";
	let workspaceMode: WorkspaceMode = "shared";
	let planRequired = false;
	for (const a of spawnArgs) {
		if (a === "fresh" || a === "branch") mode = a;
		if (a === "shared" || a === "worktree") workspaceMode = a;
		if (a === "plan") planRequired = true;
	}

	if (!nameRaw) {
		ctx.ui.notify("Usage: /team spawn <name> [fresh|branch] [shared|worktree] [plan]", "error");
		return;
	}

	const res = await spawnTeammate(ctx, { name: nameRaw, mode, workspaceMode, planRequired });
	if (!res.ok) {
		ctx.ui.notify(res.error, "error");
		return;
	}

	for (const w of res.warnings) ctx.ui.notify(w, "warning");
	ctx.ui.notify(
		`Spawned comrade '${res.name}' (${res.mode}${res.note ? ", " + res.note : ""} • ${res.workspaceMode})`,
		"info",
	);
}
