# Claude Agent Teams parity roadmap (pi-agent-teams)

Last updated: 2026-02-07

This document tracks **feature parity gaps** between:

- Claude Code **Agent Teams** (official docs)
  - https://code.claude.com/docs/en/agent-teams#control-your-agent-team
  - https://code.claude.com/docs/en/interactive-mode#task-list

…and this repository’s implementation:

- `pi-agent-teams` (Pi extension)

## Scope / philosophy

- Target the **same coordination primitives** as Claude Teams:
  - shared task list
  - mailbox messaging
  - long-lived comrades
- Prefer **inspectable, local-first artifacts** (files + lock files).
- Avoid guidance that bypasses Claude feature gating; we only document behavior.
- Accept that some Claude UX (terminal keybindings + split-pane integration) may not be achievable in Pi without deeper TUI/terminal integration.

## Parity matrix (docs-oriented)

Legend: ✅ implemented • 🟡 partial • ❌ missing

| Area | Claude docs behavior | Pi Teams status | Notes / next step | Priority |
| --- | --- | --- | --- | --- |
| Enablement | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + settings | N/A | Pi extension is always available when installed/loaded. | — |
| Team config | `~/.claude/teams/<team>/config.json` w/ members | ✅ | Implemented via `extensions/teams/team-config.ts` (stored under `~/.pi/agent/teams/...` or `PI_TEAMS_ROOT_DIR`). | P0 |
| Task list (shared) | `~/.claude/tasks/<taskListId>/` + states + deps | ✅ | File-per-task + deps (`blockedBy`/`blocks`); `/team task dep add|rm|ls`; self-claim skips blocked tasks. | P0 |
| Self-claim | Comrades can self-claim next unassigned, unblocked task; file locking | ✅ | Implemented: `claimNextAvailableTask()` + locks; enabled by default (`PI_TEAMS_DEFAULT_AUTO_CLAIM=1`). | P0 |
| Explicit assign | Lead assigns task to comrade | ✅ | `/team task assign` sets owner + pings via mailbox. | P0 |
| “Message” vs “broadcast” | Send to one comrade or all comrades | ✅ | `/team dm` + `/team broadcast` use mailbox; `/team send` uses RPC. Broadcast recipients = team config workers + RPC-spawned map + active task owners; manual tmux workers self-register into `config.json` on startup. | P0 |
| Comrade↔comrade messaging | Comrades can message each other directly | ✅ | Workers register `team_message` LLM-callable tool; sends via mailbox + CC's leader with `peer_dm_sent` notification. | P1 |
| Display modes | In-process selection (Shift+Up/Down); split panes (tmux/iTerm) | ❌ | Pi has a widget + commands, but no terminal-level comrade navigation/panes. | P2 |
| Delegate mode | Lead restricted to coordination-only tools | ✅ | `/team delegate [on|off]` toggles; `pi.on("tool_call")` blocks `bash/edit/write`; `PI_TEAMS_DELEGATE_MODE=1` env. Widget shows `[delegate]`. | P1 |
| Plan approval | Comrade can be "plan required" and needs lead approval to implement | ✅ | `/team spawn <name> plan` sets `PI_TEAMS_PLAN_REQUIRED=1`; worker restricted to read-only tools; submits plan via `plan_approval_request`; `/team plan approve|reject <name>`. | P1 |
| Shutdown handshake | Lead requests shutdown; comrade can approve/reject | ✅ | Full protocol: `shutdown_request` → `shutdown_approved` or `shutdown_rejected` (when worker is busy). `/team shutdown <name>` (graceful) + `/team kill` (force). | P1 |
| Cleanup team | “Clean up the team” removes shared resources after comrades stopped | ✅ | `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks. | P1 |
| Hooks / quality gates | `ComradeIdle`, `TaskCompleted` hooks | ❌ | Add optional hook runner in leader on idle/task-complete events (script execution + exit-code gating). | P2 |
| Task list UX | Ctrl+T toggle; show all/clear tasks by asking | 🟡 | Widget + `/team task list` show blocked/deps; `/team task show <id>`; `/team task clear [completed|all]`. No Ctrl+T toggle yet. | P0 |
| Shared task list across sessions | `CLAUDE_CODE_TASK_LIST_ID=...` | ✅ | `PI_TEAMS_TASK_LIST_ID` env on leader + worker; `/team task use <taskListId>` switches the leader (and newly spawned workers). Existing workers need a restart to pick up changes. Persisted in config.json. | P1 |

## Prioritized roadmap

### P0 (done): collaboration primitives parity

1) **Task dependency commands + UX** ✅
   - `/team task dep add <id> <depId>` / `dep rm ...` / `dep ls <id>`
   - `task list` output shows blocked status + deps/blocks summary
   - `/team task show <id>` shows full description + `metadata.result`

2) **Broadcast messaging** ✅
   - `/team broadcast <msg...>` (mailbox broadcast)

3) **Task list hygiene** ✅
   - `/team task clear [completed|all] [--force]` (safe delete within `teamsRoot/teamId`)

### P1 (done): governance + lifecycle parity

4) **Shutdown handshake** ✅
   - Full protocol: `shutdown_request` → `shutdown_approved` / `shutdown_rejected`
   - Worker rejects when busy (streaming + active task), auto-approves when idle
   - Leader command: `/team shutdown <name> [reason...]` (graceful), `/team kill` as force

5) **Plan approval** ✅
   - `/team spawn <name> [fresh|branch] [shared|worktree] plan` sets `PI_TEAMS_PLAN_REQUIRED=1`
   - Worker starts with read-only tools (`read`, `grep`, `find`, `ls`)
   - After first `agent_end`, sends `plan_approval_request` to leader via mailbox
   - `/team plan approve <name>` → worker gets full tools and proceeds
   - `/team plan reject <name> [feedback...]` → worker revises plan (stays read-only)

6) **Delegate mode (leader)** ✅
   - `/team delegate [on|off]` toggle (or `PI_TEAMS_DELEGATE_MODE=1` env)
   - `tool_call` hook blocks `bash`, `edit`, `write` when active
   - Widget shows `[delegate]` indicator

7) **Cleanup** ✅
   - `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks.
   - Refuses if RPC comrades are running or there are `in_progress` tasks unless `--force`.

8) **Peer-to-peer messaging** ✅
   - Workers register `team_message` LLM-callable tool (recipient + message params)
   - Messages go via mailbox in `team` namespace; leader CC'd with `peer_dm_sent` notification

9) **Shared task list across sessions** ✅
   - `PI_TEAMS_TASK_LIST_ID` env on leader + worker sides
   - `/team task use <taskListId>` switches the leader (and newly spawned workers); restart existing workers to pick up changes
   - Task list ID persisted in team config

### P2: UX + “product-level” parity

10) **Better comrade interaction UX**
   - Explore whether Pi’s TUI API can support:
     - selecting a comrade from the widget
     - “entering” a comrade transcript view
   - (Optional) tmux integration for split panes.

11) **Hooks / quality gates**
   - Support scripts that run on idle/task completion (similar to Claude hooks).

12) **Join/attach flow**
   - Allow a running session to attach to an existing team (discover + approve join).

## Where changes would land (code map)

- Leader orchestration + commands + tool: `extensions/teams/leader.ts`
- Worker mailbox polling + self-claim + protocols: `extensions/teams/worker.ts`
- Task store + locking: `extensions/teams/task-store.ts`, `extensions/teams/fs-lock.ts`
- Mailbox store + locking: `extensions/teams/mailbox.ts`
- Team config: `extensions/teams/team-config.ts`
- Optional workspace isolation: `extensions/teams/worktree.ts`

## Testing strategy

- Keep tests hermetic by setting `PI_TEAMS_ROOT_DIR` to a temp directory.
- Extend:
  - `scripts/smoke-test.mjs` for filesystem-only behaviors (deps, claiming, locking)
  - `scripts/e2e-rpc-test.mjs` for protocol flows (shutdown handshake, plan approval)
