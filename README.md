# pi-agent-teams

An experimental [Pi](https://pi.dev) extension that brings [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) to Pi. Spawn teammates, share a task list, and coordinate work across multiple Pi sessions.

> **Status:** MVP (command-driven + status widget). See [`docs/claude-parity.md`](docs/claude-parity.md) for the full roadmap.

## Features

Core agent-teams primitives, matching Claude's design:

- **Shared task list** — file-per-task on disk with three states (pending / in-progress / completed) and dependency tracking so blocked tasks stay blocked until their prerequisites finish.
- **Auto-claim** — idle teammates automatically pick up the next unassigned, unblocked task. No manual dispatching required (disable with `PI_TEAMS_DEFAULT_AUTO_CLAIM=0`).
- **Direct messages and broadcast** — send a message to one teammate or all of them at once, via file-based mailboxes.
- **Graceful lifecycle** — spawn, stop, shutdown (with handshake), or kill teammates. The leader tracks who's online, idle, or streaming.
- **LLM-callable delegate tool** — the model can spawn teammates and create/assign tasks in a single tool call, no slash commands needed.
- **Team cleanup** — tear down all team artifacts (tasks, mailboxes, sessions, worktrees) when you're done.

Additional Pi-specific capabilities:

- **Git worktrees** — optionally give each teammate its own worktree so they work on isolated branches without conflicting edits.
- **Session branching** — clone the leader's conversation context into a teammate so it starts with full awareness of the work so far, instead of from scratch.

## UI style

The extension supports two UI styles:

- **normal** (default): "Team leader" + "Teammate <name>"
- **soviet**: "Chairman" + "Comrade <name>" (in soviet mode, the system decides names for you)

Configure via:
- env: `PI_TEAMS_STYLE=normal|soviet`
- command: `/team style normal` or `/team style soviet`

## Install

**Option A — install from npm:**

```bash
pi install npm:@tmustier/pi-agent-teams
```

**Option B — load directly (dev):**

```bash
pi -e ~/projects/pi-agent-teams/extensions/teams/index.ts
```

**Option C — install from a local folder:**

```bash
pi install ~/projects/pi-agent-teams
```

Then run `pi` normally; the extension auto-discovers.

Verify with `/team id` — it should print the current team info.

## Quick start

The fastest way to get going is `/swarm`:

```
/swarm build the auth module               # agent spawns a team and coordinates the work
/swarm                                     # agent asks you what to do, then swarms on it
```

Or drive it manually:

```
/team spawn alice                          # spawn a teammate (fresh session, shared workspace)
/team spawn bob branch worktree            # spawn with leader context + isolated worktree

/team task add alice: Fix failing tests    # create a task and assign it to alice
/team task add Refactor auth module        # unassigned — auto-claimed by next idle teammate

/team dm alice Check the edge cases too    # direct message
/team broadcast Wrapping up soon           # message everyone

/tw                                        # open the interactive widget panel

/team shutdown alice                       # graceful shutdown (handshake)
/team cleanup                              # remove team artifacts when done
```

Or let the model drive it with the delegate tool:

```json
{
  "action": "delegate",
  "contextMode": "branch",
  "workspaceMode": "worktree",
  "teammates": ["alice", "bob"],
  "tasks": [
    { "text": "Fix failing unit tests" },
    { "text": "Refactor auth module" }
  ]
}
```

## Commands

### Shortcuts

| Command | Description |
| --- | --- |
| `/swarm [task]` | Tell the agent to spawn a team and work on a task |
| `/tw` | Open the interactive widget panel |

### Team management

All management commands live under `/team`.

| Command | Description |
| --- | --- |
| `/team spawn <name> [fresh\|branch] [shared\|worktree]` | Start a teammate |
| `/team list` | List teammates and their status |
| `/team panel` | Interactive widget panel (same as `/tw`) |
| `/team style <normal\|soviet>` | Set UI style (normal/soviet) |
| `/team send <name> <msg>` | Send a prompt over RPC |
| `/team steer <name> <msg>` | Redirect an in-flight run |
| `/team dm <name> <msg>` | Send a mailbox message |
| `/team broadcast <msg>` | Message all teammates |
| `/team stop <name> [reason]` | Abort current work (resets task to pending) |
| `/team shutdown <name> [reason]` | Graceful shutdown (handshake) |
| `/team shutdown` | Shutdown leader + all teammates |
| `/team kill <name>` | Force-terminate |
| `/team cleanup [--force]` | Delete team artifacts |
| `/team id` | Print team/task-list IDs and paths |
| `/team env <name>` | Print env vars to start a manual teammate |

### Tasks

| Command | Description |
| --- | --- |
| `/team task add <text>` | Create a task (prefix with `name:` to assign) |
| `/team task assign <id> <agent>` | Assign a task |
| `/team task unassign <id>` | Remove assignment |
| `/team task list` | Show tasks with status, deps, blocks |
| `/team task show <id>` | Full description + result |
| `/team task dep add <id> <depId>` | Add a dependency |
| `/team task dep rm <id> <depId>` | Remove a dependency |
| `/team task dep ls <id>` | Show deps and blocks |
| `/team task clear [completed\|all]` | Delete task files |

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `PI_TEAMS_ROOT_DIR` | Storage root (absolute or relative to `~/.pi/agent`) | `~/.pi/agent/teams` |
| `PI_TEAMS_DEFAULT_AUTO_CLAIM` | Whether spawned teammates auto-claim tasks | `1` (on) |
| `PI_TEAMS_STYLE` | UI style (`normal` or `soviet`) | `normal` |

## Storage layout

```
<teamsRoot>/<teamId>/
  config.json                          # team metadata + members
  tasks/<taskListId>/
    1.json, 2.json, ...                # one file per task
    .highwatermark                      # next task ID
  mailboxes/<namespace>/inboxes/
    <agent>.json                        # per-agent inbox
  sessions/                             # teammate session files
  worktrees/<agent>/                    # git worktrees (when enabled)
```

## Development

### Smoke test (no API keys)

```bash
node scripts/smoke-test.mjs
```

Filesystem-level test of the task store, mailbox, and team config.

### E2E RPC test (spawns pi + one teammate)

```bash
node scripts/e2e-rpc-test.mjs
```

Starts a leader in RPC mode, spawns a teammate, runs a shutdown handshake, verifies cleanup. Sets `PI_TEAMS_ROOT_DIR` to a temp directory so nothing touches `~/.pi/agent/teams`.

### tmux dogfooding

```bash
./scripts/start-tmux-team.sh pi-teams alice bob
tmux attach -t pi-teams
```

Starts a leader + one tmux window per teammate for interactive testing.

## License

MIT (see [`LICENSE`](LICENSE)).
