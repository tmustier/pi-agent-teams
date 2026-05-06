# Tmux Worker Live Status Plan

## Context

After switching to tmux-backed teammates, the team widget/panel can show a teammate as `idle · 0 tokens` even while the teammate is actively working in its tmux pane. This happened with `bob`: the task was read and the session transcript showed active tool calls, but `member_status` and the widget still showed idle.

The root cause is likely architectural: RPC teammates stream `AgentEvent`s back to the leader, while `TeammateTmux.onEvent()` is currently a no-op. The worker process records activity in its own session file and task/mailbox state, but the leader does not consume that activity live.

## Goal

Make tmux-backed teammates observable enough that the leader status, widget, and panel reflect real activity instead of stale `idle · 0 tokens` state.

## Findings

- `extensions/teams/teammate-rpc.ts` parses JSON-RPC stdout events and updates `status`, `lastAssistantText`, `lastEventAt`, and tool activity via event listeners.
- `extensions/teams/teammate-tmux.ts` currently implements `onEvent()` as a no-op because interactive tmux panes do not stream RPC events to the leader.
- `extensions/teams/worker.ts` already updates task files and sends mailbox notifications, but that is not enough for live token/tool status.
- Worker session files are known to the leader through `config.json` member metadata and `TeammateTmux.sessionFile`.
- The tmux worker session JSONL contains enough entries to infer activity:
  - user task prompts;
  - assistant messages with tool calls;
  - tool results;
  - final assistant messages;
  - usage/token data in assistant entries.

## Approach

Add a best-effort tmux activity bridge that tails/parses each worker session file and emits synthetic `AgentEvent`-like updates to the existing leader activity pipeline.

Prefer reusing the existing `ActivityTracker`, `TranscriptTracker`, widget, panel, and `member_status` paths instead of adding a separate tmux-only status system.

## Files to modify

- `extensions/teams/teammate-tmux.ts`
- `extensions/teams/activity-tracker.ts` if synthetic events need small compatibility support
- `extensions/teams/teams-ui-shared.ts` if `member_status` needs tmux-specific fallback details
- `extensions/teams/leader.ts` only if spawn/refresh wiring needs adjustment
- `scripts/smoke-test.mts`
- optional docs: `README.md`, `skills/agent-teams/SKILL.md`

## Implementation steps

- [ ] Inspect the session JSONL entry format used by Pi for tmux worker sessions and define the minimal parsed entry types needed for activity inference.
- [ ] Add a session-file watcher/poller to `TeammateTmux`:
  - start after the pane is spawned;
  - remember byte offset or entry count;
  - parse only newly appended JSONL lines;
  - stop on teammate stop/kill.
- [ ] Emit synthetic activity events through `TeammateTmux.onEvent()` listeners:
  - `agent_start` when a new user prompt appears or assistant processing begins;
  - `tool_execution_start` for assistant `toolCall` blocks;
  - `tool_execution_end` for matching `toolResult` entries;
  - `agent_end` when an assistant final response appears;
  - optionally `message_update` or transcript text snapshots if feasible.
- [ ] Update `TeammateTmux.status`, `lastStatusChangeAt`, and `lastEventAt` from parsed activity:
  - mark `streaming` when a new user prompt/tool call appears;
  - mark `idle` after final assistant response or task completion/idle notification;
  - keep `currentTaskId` in sync where possible from task prompts or task store refresh.
- [ ] Parse assistant usage from session entries and expose token deltas if the existing tracker can consume them; otherwise add a lightweight tmux token fallback in status display.
- [ ] Ensure stale old teammates disappear correctly:
  - graceful shutdown marks offline;
  - force kill removes/stops the handle;
  - panel/member_status should not show previously killed teammates as active.
- [ ] Add smoke tests for the tmux activity bridge with a temporary JSONL session file:
  - append a user prompt and assert status becomes streaming;
  - append a tool call and assert a tool-start event reaches listeners;
  - append a tool result and final assistant text and assert status returns idle;
  - assert token/last-event metadata updates.
- [ ] Add a regression test or documented manual smoke for the exact scenario: spawn tmux teammate, assign task, verify widget/status changes while it works.

## Verification

Automated:

```bash
npm run typecheck
npm run lint
npm run smoke-test
```

Manual tmux smoke test:

1. Start Pi inside tmux with `PI_TEAMS_SPAWN_MODE=tmux`.
2. Spawn one teammate and delegate a task that uses tools for at least a few seconds.
3. Confirm `/team status` / `member_status` changes from `idle` to working/tool activity.
4. Confirm widget/panel show current tool activity and nonzero token/activity metadata when available.
5. Complete the task and confirm status returns to idle/completed.
6. Shut down or kill the teammate and confirm it disappears or shows offline correctly.

## Acceptance criteria

- A tmux teammate actively reading/running tools is not shown as long-idle with `0 tokens`.
- The leader widget/panel/member status reflect recent tmux worker activity within a short polling interval.
- RPC teammate behavior remains unchanged.
- Tmux activity tracking is best-effort and does not crash the leader on partial JSONL writes, truncation, or malformed lines.
