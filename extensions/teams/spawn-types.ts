import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ContextMode = "fresh" | "branch";
export type WorkspaceMode = "shared" | "worktree";

export type SpawnTeammateResult =
	| {
			ok: true;
			name: string;
			mode: ContextMode;
			workspaceMode: WorkspaceMode;
			childCwd?: string;
			note?: string;
			warnings: string[];
	  }
	| { ok: false; error: string };

export type SpawnTeammateFn = (
	ctx: ExtensionContext,
	opts: { name: string; mode?: ContextMode; workspaceMode?: WorkspaceMode; planRequired?: boolean },
) => Promise<SpawnTeammateResult>;
