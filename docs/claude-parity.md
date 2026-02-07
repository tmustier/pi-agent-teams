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
  - long-lived teammates
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
| Self-claim | Teammates can self-claim next unassigned, unblocked task; file locking | ✅ | Implemented: `claimNextAvailableTask()` + locks; enabled by default (`PI_TEAMS_DEFAULT_AUTO_CLAIM=1`). | P0 |
| Explicit assign | Lead assigns task to teammate | ✅ | `/team task assign` sets owner + pings via mailbox. | P0 |
| “Message” vs “broadcast” | Send to one teammate or all teammates | ✅ | `/team dm` + `/team broadcast` use mailbox; `/team send` uses RPC. Broadcast recipients = team config workers + RPC-spawned map + active task owners; manual tmux workers self-register into `config.json` on startup. | P0 |
| Teammate↔teammate messaging | Teammates can message each other directly | ❌ | Worker needs peer discovery (read team config) + send command/tool. | P1 |
| Display modes | In-process selection (Shift+Up/Down); split panes (tmux/iTerm) | ❌ | Pi has a widget + commands, but no terminal-level teammate navigation/panes. | P2 |
| Delegate mode | Lead restricted to coordination-only tools | ❌ | Add a leader “delegate mode” switch that blocks edit/write/bash tools (soft or enforced). | P1 |
| Plan approval | Teammate can be “plan required” and needs lead approval to implement | ❌ | Likely implement by spawning with read-only tool set until approved, then restart worker with full tools. | P1 |
| Shutdown handshake | Lead requests shutdown; teammate can approve/reject | 🟡 | Implemented `shutdown_request` → `shutdown_approved` via mailbox + `/team shutdown <name>` (auto-approve; no reject yet). | P1 |
| Cleanup team | “Clean up the team” removes shared resources after teammates stopped | ✅ | `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks. | P1 |
| Hooks / quality gates | `TeammateIdle`, `TaskCompleted` hooks | ❌ | Add optional hook runner in leader on idle/task-complete events (script execution + exit-code gating). | P2 |
| Task list UX | Ctrl+T toggle; show all/clear tasks by asking | 🟡 | Widget + `/team task list` show blocked/deps; `/team task show <id>`; `/team task clear [completed|all]`. No Ctrl+T toggle yet. | P0 |
| Shared task list across sessions | `CLAUDE_CODE_TASK_LIST_ID=...` | 🟡 | Pi supports `PI_TEAMS_TASK_LIST_ID` env (worker side) but leader doesn’t expose a stable “named task list id” workflow yet. | P1 |

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

### P1: governance + lifecycle parity

4) **Shutdown handshake** 🟡
   - Mailbox protocol: `shutdown_request` → `shutdown_approved` (no reject yet)
   - Leader command: `/team shutdown <name> [reason...]` (graceful), keep `/team kill` as force

5) **Plan approval**
   - Spawn option: `--plan-required` / `/team spawn <name> plan` (naming TBD)
   - Worker flow: produce plan → send approval request → wait → implement after approval
   - Enforcement idea: start worker with tools excluding write/edit/bash, then restart same session with full tool set after approval

6) **Delegate mode (leader)**
   - A toggle (env or command) that prevents the leader from doing code edits and focuses it on coordination.
   - In Pi, likely implemented as: leader tool wrapper refuses `bash/edit/write` while delegate mode is on.

7) **Cleanup** ✅
   - `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks.
   - Refuses if RPC teammates are running or there are `in_progress` tasks unless `--force`.

### P2: UX + “product-level” parity

8) **Better teammate interaction UX**
   - Explore whether Pi’s TUI API can support:
     - selecting a teammate from the widget
     - “entering” a teammate transcript view
   - (Optional) tmux integration for split panes.

9) **Hooks / quality gates**
   - Support scripts that run on idle/task completion (similar to Claude hooks).

10) **Join/attach flow**
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
