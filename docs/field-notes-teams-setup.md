# Field notes: using `pi-agent-teams` for real (setup + surprises)

Date: 2026-02-07

Goal: dogfood the Teams extension to implement its own roadmap (Claude parity), and capture anything that surprised/confused us while setting it up.

> Terminology note: the extension supports `PI_TEAMS_STYLE=<style>`. Built-ins: `normal`, `soviet`, `pirate`. You can also add custom styles via `~/.pi/agent/teams/_styles/<style>.json`.

## Test run: test1

Decisions: tmux session `pi-teams-test1`; `PI_TEAMS_ROOT_DIR=~/projects/pi-agent-teams/test1`; `teamId=0baaa0e6-8020-4d9a-bf33-c1a65f99a2f7`; workers started manually in tmux (not `/team spawn`).

First impressions:
- Manual tmux workers are usable. Initially the leader showed “(no comrades)” because it only tracked RPC-spawned workers; now manual workers **upsert themselves into `config.json` on startup**, and the leader widget renders online workers from team config.
- Pinning `PI_TEAMS_ROOT_DIR` made reruns/id discovery predictable (no “find the new folder” step).
- tmux workflow feels close to Claude-style split panes; bootstrap ergonomics still need smoothing.
- Surprise: `/team spawn <name> branch` failed once with `Entry <id> not found` (branch-from leaf missing on disk); `/team spawn <name> fresh` worked.
- Surprise (automation): when driving the leader via `tmux send-keys`, back-to-back `/team ...` commands sometimes only executed the first one unless we inserted a small delay.

## Setup (tmux-based)

### Why tmux?

- Pi sessions are long-lived and interactive.
- Our harness (and many CI environments) dislike background processes that keep stdio open.
- tmux gives us:
  - a stable place to run a leader session
  - optional separate panes/windows for worker sessions
  - the ability to attach/detach without killing the team

### Environment knobs used

- `PI_TEAMS_ROOT_DIR` — isolate Teams artifacts from `~/.pi/agent/teams` while experimenting.
  - Recommendation: use a *fresh, empty* temp directory per run so it’s easy to discover the current teamId by listing the directory.

### Session bootstrap (manual)

(There is also a helper script now: `./scripts/start-tmux-team.sh`.)

1. Pick a temp Teams root:

   ```bash
   export PI_TEAMS_ROOT_DIR="/tmp/pi-teams-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$PI_TEAMS_ROOT_DIR"
   ```

2. Start leader in tmux:

   ```bash
   tmux new -s pi-teams -c ~/projects/pi-agent-teams \
     "PI_TEAMS_ROOT_DIR=$PI_TEAMS_ROOT_DIR pi -e ~/projects/pi-agent-teams/extensions/teams/index.ts"
   ```

3. In the leader session:

   ```
   /team help
   /team spawn alice branch
   /team spawn bob branch
   /team task add alice: add /team broadcast command
   /team task add bob: add task dependency commands
   /team task list
   ```

4. Optional: start **interactive worker panes** (instead of leader-spawned RPC workers).

   This currently requires discovering the leader’s `teamId` first (see “Surprises” below).

## Surprises / confusion points (so far)

- **TeamId discoverability**: the leader uses `sessionId` as `teamId`. That’s convenient internally, but not obvious externally.
  - Workaround used: point `PI_TEAMS_ROOT_DIR` at a fresh directory and `ls` it to find the generated `<teamId>` folder.
  - Note: the team directory isn’t necessarily created instantly on process start (we saw a short delay), so scripts may need a small retry loop.
  - Update: implemented `/team id` and `/team env <name>` (prints env vars + a one-liner to start a manual worker).

- **tmux vs `/team spawn`**: `/team spawn` uses `pi --mode rpc` subprocesses.
  - Pros: simple, managed lifecycle.
  - Cons: you don’t see a full interactive comrade UI like Claude’s split-pane mode.
  - We manually started workers in separate tmux windows (setting `PI_TEAMS_WORKER=1`, `PI_TEAMS_TEAM_ID=...`, etc). This now shows up in the leader widget because workers upsert themselves into `config.json`, and the leader renders online workers from team config.
  - Update: leader now renders comrades from `team config` and also auto-adds unknown senders on idle notifications (so manual tmux workers feel first-class).
  - Improvement idea: optional spawn mode that starts a worker in a new tmux pane/window.

- **Two messaging paths** (`/team send` vs `/team dm`):
  - `/team send` = RPC prompt (immediate “user message”)
  - `/team dm` = mailbox message (Claude-style)
  - Improvement idea: clearer naming and/or a single “message” command with a mode flag.

- **Runaway tasks / timeboxing**: a vague task prompt can turn into a long “research spiral”.
  - In manual-tmux mode, there isn’t a great way (yet) for the leader to *steer* an in-flight run (unlike `/team steer` for RPC-spawned comrades).
  - Improvement idea: add a mailbox-level “steer” protocol message that workers can treat as an in-flight follow-up if they’re currently running.

- **Failure semantics are underspecified**: tool failures show up in the worker UI, but our task store currently only supports `pending|in_progress|completed`.
  - Update: `/team stop <name>` now sends a mailbox `abort_request`; workers treat aborts as aborts and reset the task back to `pending` (keeping the `owner`) instead of marking it `completed` with an empty result.
  - Improvement idea: add `failed` status (and have workers write `metadata.failureReason` + include it in idle notifications), and only mark `completed` when we have an explicit success signal.

- **Worker shutdown + self-claim interaction**: when a worker receives SIGTERM it unassigns its non-completed tasks; other idle workers may immediately self-claim those now-unowned tasks.
  - This is good for liveness, but surprising the first time you see task ownership “jump”.

- **Nice surprise: results are persisted with the task**: on completion, the worker writes `metadata.result` + `metadata.completedAt` into the task JSON file.
  - This made it easy to recover outputs even after closing tmux windows.

## Next notes to capture

- How easy it is to recover after restarting the leader
- How often we hit file/lock contention
- Whether auto-claim behavior matches expectations in mixed assigned/unassigned task lists
- Whether worktree mode is essential in practice (and what breaks when no git repo exists)
