# Changelog

## 0.5.2

### Fixes

- **Pi 0.62 metadata compatibility** — updated tool metadata wiring for recent Pi releases so teams tools continue to render the right prompt snippets/guidelines and stay compatible with current core APIs.
- **Non-interactive exit hang** — leader polling timers now call `unref()` so print/json child sessions can exit cleanly instead of hanging after the agent finishes. This fixes subagent and other nested Pi flows that load the teams extension in the background.

## 0.5.1

### Features

- **Automatic startup GC** — on session start, silently removes stale team directories older than 24h (fire-and-forget, never blocks). Reuses the existing `gcStaleTeamDirs()` with age + state checks. (Thanks **@RensTillmann** — #8, #30)
- **Exit cleanup of empty team dirs** — on session shutdown, deletes the session's own team directory if it has no tasks in any namespace, no active teammates (RPC or manual), and no attach claim from another session. (Thanks **@RensTillmann** — #8, #30)

### Fixes

- Added `excludeTeamIds` parameter to `gcStaleTeamDirs()` to prevent startup GC from removing the current session's team (important for resumed sessions older than 24h).

## 0.5.0

### Features

- **DM routing to leader LLM context** — Teammate DMs are now injected into the leader's conversation via `sendLeaderLlmMessage` instead of only showing in the TUI. The leader can now act on DM requests autonomously. (Thanks **@davidsu** — #6, #29)
- **Batch-complete auto-wake** — `DelegationTracker` tracks task ID batches from `delegate()` calls. When all tasks in a batch complete, the idle leader is automatically woken to review results and continue orchestrating. Quality-gate aware. (Thanks **@RensTillmann** — #7, #29)
- **Worker completion messages in leader context** — Per-task completion/failure notifications injected into the leader LLM conversation with task subject, result summary, and progress counters. All-done detection warns when quality gates are still running. (#13)
- **Ergonomic worker status** — Real-time time-in-state, stall detection (configurable via `PI_TEAMS_STALL_THRESHOLD_MS`), last message summary, and model-per-worker in panel detail view. `member_status` tool action for agent-driven orchestration. (#10)
- **Tool call content in transcript** — Worker transcript view shows tool arguments inline: file paths, commands, patterns. Errors marked with ✗. (#18, #21, #23)
- **`/team done` + auto-done detection** — `/team done` ends a run (stops teammates, hides widget, notifies with summary). Widget auto-detects when all tasks complete. (#16)
- **Hook/model policy in panel** — Compact policy summary (hooks status, failure action, reopens, model inheritance) shown in widget and panel. (#20)
- **Model, thinking, task in spawn/panel** — Visible in spawn output, panel detail, and transcript header. (#19)
- **Urgent message interrupts** — `--urgent` flag on `/team dm` and `/team broadcast` interrupts active worker turns via steering. (#15)
- **Hook contract versioning** — Formal versioning and compatibility policy for quality-gate hooks. (#24)

### Fixes

- **Worktree/branch auto-cleanup** — Stale team dirs, worktrees, and branches cleaned up on shutdown and session switch. (#14)
- **`/team status` in README** — Added missing command to docs table. (#27)
- **Activity tracker** — Added `extractStartSummary`/`extractEndSummary` for tool transcript display.

## 0.4.0

Initial public release.
