# pi-agent-teams

A Pi extension that adds a lightweight **Teams** workflow by spawning teammate `pi` subprocesses and coordinating. Inspired by [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams#control-your-agent-team):

- Shared **task list on disk** (file-per-task)
- File-based **mailboxes** (inboxes) for task assignment pings + DM + idle notifications
- **Self-claim** (on by default, Claude-style): idle workers claim the next open *unassigned* task

Status: MVP (command-driven + a small status widget).

Roadmap / Claude parity checklist:
- `docs/claude-parity.md`

## Dev workflow

### Smoke test (no API keys required)

Runs a small filesystem-level test of the task store + mailbox + team config:

```bash
cd ~/projects/pi-agent-teams
node scripts/smoke-test.mjs
```

### E2E RPC test (spawns pi + one teammate)

Runs a minimal end-to-end test by starting a leader `pi --mode rpc`, spawning one worker, requesting a graceful shutdown via mailbox handshake (`/team shutdown <name>`), verifying `config.json` goes offline, then shutting down the leader.

Notes:
- No model calls are made (should not require API keys).
- The script keeps your normal Pi config/credentials, but sets `PI_TEAMS_ROOT_DIR` to a temporary directory so it doesn’t write into `~/.pi/agent/teams`.

```bash
cd ~/projects/pi-agent-teams
node scripts/e2e-rpc-test.mjs
```

### tmux: leader + interactive worker panes (dogfooding)

This repo includes a helper that starts a **leader** plus one tmux window per **worker** (interactive sessions), using a fresh temp `PI_TEAMS_ROOT_DIR` by default:

```bash
cd ~/projects/pi-agent-teams
./scripts/start-tmux-team.sh pi-teams alice bob
# then:
#   tmux attach -t pi-teams
```

(We intentionally do not commit terminal screenshots to the public repo. Capture local screenshots under `.artifacts/` if needed.)

### Load directly

```bash
pi -e ~/projects/pi-agent-teams/extensions/teams/index.ts
```

### Install as a Pi package (optional)

```bash
pi install ~/projects/pi-agent-teams
```

Then run `pi` normally; the extension will be auto-discovered.

## Commands

### Teammates

- `/team id` – print the current `teamId`/`taskListId`/`leadName` plus `teamsRoot` + `teamDir`
- `/team env <name>` – print copy/paste env vars + a `pi` command to start an interactive worker manually (tmux-friendly)
- `/team spawn <name> [fresh|branch] [shared|worktree]` – start a teammate process (`pi --mode rpc`)
  - Leader assigns teammate session names like `pi agent teams - comrade <name>` (shows in the session selector via `session_info`).
  - Spawns workers with `--no-extensions -e <this-extension>` when possible, so dev mode works without installing.
  - `worktree` mode creates a per-teammate git worktree under `<teamsRoot>/<teamId>/worktrees/<name>`.
    - Warns (but does not block) if your git working directory is not clean.
    - Falls back to `shared` if the cwd is not a git repository.
  - Self-claim is **on by default** (Claude-style). Disable it by launching the leader with `PI_TEAMS_DEFAULT_AUTO_CLAIM=0`.
- `/team send <name> <msg...>` – send a prompt over RPC (manual override; RPC teammates only)
- `/team steer <name> <msg...>` – steer an in-flight RPC teammate run (RPC teammates only)
- `/team stop <name> [reason...]` – request an abort (mailbox `abort_request` for all workers; plus RPC abort when available)
  - If the worker was running a task, it resets it back to `pending` (keeping the `owner`) instead of marking it `completed`.
- `/team dm <name> <msg...>` – send a mailbox message (Claude-style)
- `/team broadcast <msg...>` – send a mailbox message to all teammates
- `/team shutdown <name> [reason...]` – graceful teammate shutdown (mailbox handshake)
- `/team kill <name>` – terminate the process
- `/team list` – list teammates
- `/team shutdown` – shutdown leader + stop all RPC teammates (exit pi)
- `/team cleanup [--force]` – delete the current `teamDir` (tasks, mailboxes, sessions, worktrees)
  - Refuses if RPC teammates are running or if there are `in_progress` tasks unless `--force`.
  - Prompts in interactive mode; in non-interactive/RPC mode, requires `--force`.

### Task list

- `/team task add <text...>` – create a task
  - Optional assignee prefix: `alice: review the API surface` (sets `owner` and pings via mailbox)
- `/team task assign <id> <agent>` – assign an existing task (sets `owner`, pings assignee)
- `/team task unassign <id>` – clear owner (resets to pending if not completed)
- `/team task list` – show recent tasks (marks blocked tasks; shows deps/blocks counts)
- `/team task show <id>` – show full description + stored `metadata.result` (if any)
- `/team task dep add <id> <depId>` – add dependency (`<id>` is blocked until `<depId>` is completed)
- `/team task dep rm <id> <depId>` – remove dependency
- `/team task dep ls <id>` – show deps/blocks for a task
- `/team task clear [completed|all] [--force]` – delete task JSON files (defaults to `completed`)
  - Prompts in interactive mode; in non-interactive/RPC mode, requires `--force`.

## Agent tool (LLM-callable)

The extension registers an LLM-callable tool named **`teams`**.

Current action:
- `delegate` – spawn teammates (if needed) and create/assign tasks.

Example parameters (conceptual):

```json
{
  "action": "delegate",
  "contextMode": "branch",
  "workspaceMode": "worktree",
  "teammates": ["alice", "bob", "carol"],
  "tasks": [
    { "text": "Fix failing unit tests" },
    { "text": "Refactor auth module" },
    { "text": "Update README" }
  ]
}
```

## Storage

Default storage root is the Pi agent dir (usually `~/.pi/agent`) under `teams/`.

You can override the Teams storage root (useful for tests/CI) via:

- `PI_TEAMS_ROOT_DIR=/absolute/path` (recommended)
- or `PI_TEAMS_ROOT_DIR=relative/path` (relative to the agent dir)

Paths (relative to the teams root):

- Team root:
  - `<teamsRoot>/<leaderSessionId>/`

- Task list (Claude-style, file-per-task + `.highwatermark`):
  - `<teamsRoot>/<leaderSessionId>/tasks/<taskListId>/`

- Mailboxes (JSON arrays, one per agent):
  - `<teamsRoot>/<leaderSessionId>/mailboxes/<namespace>/inboxes/<agent>.json`

- Teammate sessions:
  - `<teamsRoot>/<leaderSessionId>/sessions/`

- Teammate git worktrees (when using `worktree` mode):
  - `<teamsRoot>/<leaderSessionId>/worktrees/<agent>/`

## Notes

- “branch” context uses Pi’s `SessionManager.createBranchedSession()` to clone the current leader session branch into the teammate’s session file.
- Extension runs in two modes:
  - leader mode in your main pi session
  - worker mode in teammates (enabled via env vars like `PI_TEAMS_WORKER=1`)

## License

MIT (see `LICENSE`).
