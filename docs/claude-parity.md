# Claude Agent Teams parity roadmap (pi-agent-teams)

Last updated: 2026-02-10

This document tracks **feature parity gaps** between:

- Claude Code **Agent Teams** (official docs)
  - https://code.claude.com/docs/en/agent-teams#control-your-agent-team
  - https://code.claude.com/docs/en/interactive-mode#task-list

…and this repository’s implementation:

- `pi-agent-teams` (Pi extension)

> Terminology note: this extension supports `PI_TEAMS_STYLE=<style>`.
> This doc often uses “comrade” as a generic stand-in for “worker/teammate”, but **styles can customize terminology, naming, and lifecycle copy**.
> Built-ins: `normal`, `soviet`, `pirate`. Custom styles live under `~/.pi/agent/teams/_styles/`.

## Scope / philosophy

- Target the **same coordination primitives** as Claude Teams:
  - shared task list
  - mailbox messaging
  - long-lived workers
- Prefer **inspectable, local-first artifacts** (files + lock files).
- Avoid guidance that bypasses Claude feature gating; we only document behavior.
- Accept that some Claude UX (terminal keybindings + split-pane integration) may not be achievable in Pi without deeper TUI/terminal integration.

## Pi-specific extras (not Claude parity)

These are intentional differences / additions:

- **Configurable styles** (`/team style …`) for terminology + naming + lifecycle copy.
- **Git worktrees** for isolation (`/team spawn <name> … worktree`).
- **Session branching** (clone leader context into a teammate).
- A **status widget + interactive panel** (`/tw`, `/team panel`).

## Parity matrix (docs-oriented)

Legend: ✅ implemented • 🟡 partial • ❌ missing

| Area | Claude docs behavior | Pi Teams status | Notes / next step | Priority |
| --- | --- | --- | --- | --- |
| Enablement | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + settings | N/A | Pi extension is available when installed/loaded. | — |
| Team config | `~/.claude/teams/<team>/config.json` w/ members | ✅ | `extensions/teams/team-config.ts` (under `~/.pi/agent/teams/...` or `PI_TEAMS_ROOT_DIR`). | P0 |
| Task list (shared) | `~/.claude/tasks/<taskListId>/` + states + deps | ✅ | File-per-task + deps (`blockedBy`/`blocks`); `/team task dep add|rm|ls`; self-claim skips blocked tasks. | P0 |
| Self-claim | Comrades self-claim next unassigned, unblocked task; file locking | ✅ | `claimNextAvailableTask()` + locks; enabled by default (`PI_TEAMS_DEFAULT_AUTO_CLAIM=1`). | P0 |
| Explicit assign | Lead assigns task to comrade | ✅ | `/team task assign` sets owner + pings via mailbox. | P0 |
| “Message” vs “broadcast” | Send to one comrade or all comrades | ✅ | `/team dm` + `/team broadcast` use mailbox; `/team send` uses RPC. Recipients = config workers + RPC map + active task owners. | P0 |
| Comrade↔comrade messaging | Comrades message each other directly | ✅ | Worker tool `team_message`; messages via mailbox + CC leader via `peer_dm_sent`. | P1 |
| Display modes | In-process selection (Shift+Up/Down); split panes (tmux/iTerm) | ❌ | Pi has widget/panel + commands, but no terminal-level comrade navigation/panes. | P2 |
| Delegate mode | Lead restricted to coordination-only tools | ✅ | `/team delegate [on|off]`; `tool_call` blocks `bash/edit/write`; widget shows `[delegate]`. | P1 |
| Plan approval | Comrade can be “plan required” and needs lead approval to implement | ✅ | `/team spawn <name> plan` → read-only tools; sends `plan_approval_request`; `/team plan approve|reject`. | P1 |
| Shutdown handshake | Lead requests shutdown; comrade can approve/reject | ✅ | Protocol: `shutdown_request` → `shutdown_approved` / `shutdown_rejected`. `/team shutdown <name>` (graceful), `/team kill <name>` (SIGTERM). Wording is style-controlled (e.g. “was asked to shut down”, “walked the plank”). | P1 |
| Cleanup team | “Clean up the team” removes shared resources after comrades stopped | ✅ | `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks. | P1 |
| Hooks / quality gates | `ComradeIdle`, `TaskCompleted` hooks | 🟡 | Optional leader-side hook runner (idle/task-complete/task-fail) via `PI_TEAMS_HOOKS_ENABLED=1` + scripts under `_hooks/`. Still missing richer gating UX + standardized hook contract. | P2 |
| Task list UX | Ctrl+T toggle; show all/clear tasks by asking | 🟡 | Widget + `/team task list` + `/team task show` + `/team task clear`; panel supports fast `t`/`tab` toggle into task-centric view (`Ctrl+T` is reserved by Pi for thinking blocks). | P0 |
| Shared task list across sessions | `CLAUDE_CODE_TASK_LIST_ID=...` | ✅ | Worker env: `PI_TEAMS_TASK_LIST_ID` (manual workers). Leader: `/team task use <taskListId>` (persisted). Newly spawned workers inherit; existing workers need restart. | P1 |
| Join/attach flow | Join existing team context from another running session | 🟡 | `/team attach list`, `/team attach <teamId> [--claim]`, `/team detach` plus claim heartbeat/takeover handshake added. Widget/panel now show attached-mode banner + detach hint. | P2 |

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
   - `shutdown_request` → `shutdown_approved` / `shutdown_rejected`
   - Worker rejects when busy (streaming + active task), auto-approves when idle
   - `/team shutdown <name> [reason...]` (graceful), `/team kill <name>` (force)

5) **Plan approval** ✅
   - `/team spawn <name> ... plan` sets `PI_TEAMS_PLAN_REQUIRED=1`
   - Worker starts read-only; submits `plan_approval_request`
   - `/team plan approve|reject <name>`
   - Agent-driven equivalent via `teams` tool: `plan_approve` / `plan_reject`

6) **Delegate mode (leader)** ✅
   - `/team delegate [on|off]` (or `PI_TEAMS_DELEGATE_MODE=1`)
   - Blocks `bash/edit/write` while active

7) **Cleanup** ✅
   - `/team cleanup [--force]` deletes only `<teamsRoot>/<teamId>` after safety checks.

8) **Peer-to-peer messaging** ✅
   - Worker tool `team_message`
   - Mailbox transport; leader CC notifications

9) **Shared task list across sessions** ✅
   - `/team task use <taskListId>` + persisted `config.json`

### P2: UX + “product-level” parity

10) **Hooks / quality gates** 🟡 (partial)
   - Implemented: optional leader-side hook runner (opt-in + timeout + logs).
   - Still missing: richer gating UX (e.g. surfacing hook failures inline, controlling whether failures reopen tasks / block future work).

11) **Better comrade interaction UX (within Pi constraints)** 🟡 (partial)
   - Implemented: panel overview shows selected teammate context (active/last completed task + last transcript event).
   - Implemented: faster keyboard controls (`w/s`, `1-9`, `m/d`).
   - Implemented: task-centric panel mode (`t`/`tab`) with owned-task drilldown, dependency/block visibility, and quick jump back to transcript (`Ctrl+T` reserved by Pi).
   - Implemented: in-panel task mutations for selected task (`c` complete, `p` pending, `i` in-progress, `u` unassign).
   - Implemented: in-panel reassignment flow (`r`) with teammate picker.
   - Implemented: agent-invocable task mutations via `teams` tool (`task_assign`, `task_unassign`, `task_set_status`) so flows do not require manual panel interaction.
   - Implemented: agent-invocable dependency/messaging actions via `teams` tool (`task_dep_add|rm|ls`, `message_dm|broadcast|steer`).
   - Implemented: agent-invocable lifecycle actions via `teams` tool (`member_spawn|shutdown|kill|prune`).
   - Implemented: agent-invocable governance actions via `teams` tool (`plan_approve|plan_reject`).
   - Next: optional tmux split-pane integration and deeper dependency/task editing flows in panel.

12) **Join/attach flow** 🟡 (partial)
   - Implemented: `/team attach list`, `/team attach <teamId> [--claim]`, `/team detach`.
   - Implemented: explicit attach claim handshake with heartbeat + force takeover (`--claim`).
   - Implemented: attached-mode affordances in widget/panel (external team banner + `/team detach` hint).

## Where changes would land (code map)

- Leader orchestration: `extensions/teams/leader.ts`
- Leader `/team` command dispatch: `extensions/teams/leader-team-command.ts`
- Attach/discovery commands: `extensions/teams/leader-attach-commands.ts`, `extensions/teams/team-discovery.ts`, `extensions/teams/team-attach-claim.ts`
- Leader LLM tool (`teams`): `extensions/teams/leader-teams-tool.ts`
- Worker mailbox polling + self-claim + protocols: `extensions/teams/worker.ts`
- Task store + locking: `extensions/teams/task-store.ts`, `extensions/teams/fs-lock.ts`
- Mailbox store + locking: `extensions/teams/mailbox.ts`
- Team config: `extensions/teams/team-config.ts`
- Styles + naming: `extensions/teams/teams-style.ts`
- Optional workspace isolation: `extensions/teams/worktree.ts`

## Testing strategy

- Keep tests hermetic by setting `PI_TEAMS_ROOT_DIR` to a temp directory.
- Extend:
  - `scripts/smoke-test.mts` (run via `npm run smoke-test`) for filesystem-only behaviors
  - `scripts/e2e-rpc-test.mjs` for protocol flows (shutdown handshake, plan approval)
