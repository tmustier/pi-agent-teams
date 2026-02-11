# pi-agent-teams

An experimental [Pi](https://pi.dev) extension that brings [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) to Pi. Spawn teammates, share a task list, and coordinate work across multiple Pi sessions.

> **Status:** MVP (command-driven + status widget). See [`docs/claude-parity.md`](docs/claude-parity.md) for the full roadmap.

## Features

Core agent-teams primitives, matching Claude's design:

- **Shared task list** — file-per-task on disk with three states (pending / in-progress / completed) and dependency tracking so blocked tasks stay blocked until their prerequisites finish.
- **Auto-claim** — idle teammates automatically pick up the next unassigned, unblocked task. No manual dispatching required (disable with `PI_TEAMS_DEFAULT_AUTO_CLAIM=0`).
- **Direct messages and broadcast** — send a message to one teammate or all of them at once, via file-based mailboxes.
- **Graceful lifecycle** — spawn, stop, shutdown (with handshake), or kill teammates. The leader tracks who's online, idle, or streaming.
- **LLM-callable teams tool** — the model can spawn teammates, delegate tasks, mutate task assignment/status/dependencies, message teammates, and run lifecycle actions in tool calls (no slash commands needed).
- **Team cleanup** — tear down all team artifacts (tasks, mailboxes, sessions, worktrees) when you're done.

Additional Pi-specific capabilities:

- **Git worktrees** — optionally give each teammate its own worktree so they work on isolated branches without conflicting edits.
- **Session branching** — clone the leader's conversation context into a teammate so it starts with full awareness of the work so far, instead of from scratch.
- **Hooks / quality gates** — optional leader-side hooks on idle / task completion to run scripts (opt-in).

## UI style (terminology + naming)

Built-in styles:

- **normal** (default): "Team leader" + "Teammate <name>" (spawn requires explicit name)
- **soviet**: "Chairman" + "Comrade <name>" (spawn can auto-pick names)
- **pirate**: "Captain" + "Matey <name>" (spawn can auto-pick names)

Configure via:
- env: `PI_TEAMS_STYLE=<name>`
- command: `/team style <name>` (see: `/team style list`)

### Custom styles

You can add your own styles by creating JSON files under:

- `~/.pi/agent/teams/_styles/<style>.json`

The file can override strings and naming rules.

Strings include both terminology **and lifecycle copy**, e.g. `killedVerb`, `shutdownRequestedVerb`, `shutdownCompletedVerb`, `shutdownRefusedVerb`, `abortRequestedVerb`, plus templates like `teamEndedAllStopped`.

Example:

```json
{
  "extends": "pirate",
  "strings": {
    "memberTitle": "Deckhand",
    "memberPrefix": "Deckhand "
  },
  "naming": {
    "requireExplicitSpawnName": false,
    "autoNameStrategy": { "kind": "pool", "pool": ["pegleg", "parrot"], "fallbackBase": "deckhand" }
  }
}
```

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

/team attach list                          # discover existing teams under ~/.pi/agent/teams
/team attach <teamId> [--claim]            # attach this session to an existing team workspace (force takeover with --claim)
/team detach                               # return to this session's own team

/team task add alice: Fix failing tests    # create a task and assign it to alice
/team task add Refactor auth module        # unassigned — auto-claimed by next idle teammate

/team dm alice Check the edge cases too    # direct message
/team broadcast Wrapping up soon           # message everyone

/tw                                        # open the interactive widget panel

/team shutdown alice                       # graceful shutdown (handshake)
/team shutdown                             # stop all teammates (leader session remains active)
/team cleanup                              # remove team artifacts when done
```

Or let the model drive it with the delegate tool:

```json
{
  "action": "delegate",
  "contextMode": "branch",
  "workspaceMode": "worktree",
  "model": "anthropic/claude-sonnet-4",
  "thinking": "high",
  "teammates": ["alice", "bob"],
  "tasks": [
    { "text": "Fix failing unit tests" },
    { "text": "Refactor auth module" }
  ]
}
```

### Teams tool action reference (agent-run)

| Action | Required fields | Purpose |
| --- | --- | --- |
| `delegate` | `tasks` | Spawn teammates as needed and create/assign tasks. |
| `task_assign` | `taskId`, `assignee` | Assign/reassign a task owner. |
| `task_unassign` | `taskId` | Clear owner (resets to pending for non-completed tasks). |
| `task_set_status` | `taskId`, `status` | Set status to `pending`, `in_progress`, or `completed`. |
| `task_dep_add` | `taskId`, `depId` | Add dependency edge (`taskId` depends on `depId`). |
| `task_dep_rm` | `taskId`, `depId` | Remove dependency edge. |
| `task_dep_ls` | `taskId` | Inspect dependency/block graph for one task. |
| `message_dm` | `name`, `message` | Send mailbox DM to one teammate. |
| `message_broadcast` | `message` | Send mailbox message to all discovered workers. |
| `message_steer` | `name`, `message` | Send steer instruction to a running RPC teammate. |
| `member_spawn` | `name` | Spawn one teammate (supports context/workspace/model/thinking/plan options). |
| `member_shutdown` | `name` or `all=true` | Request graceful shutdown via mailbox handshake. |
| `member_kill` | `name` | Force-stop one RPC teammate and unassign active tasks. |
| `member_prune` | _(none)_ | Mark stale non-RPC workers offline (`all=true` to force). |
| `plan_approve` | `name` | Approve pending plan for a plan-required teammate. |
| `plan_reject` | `name` | Reject pending plan (`feedback` optional). |

Example calls:

```json
{ "action": "task_assign", "taskId": "12", "assignee": "alice" }
{ "action": "task_dep_add", "taskId": "12", "depId": "7" }
{ "action": "message_broadcast", "message": "Sync: finishing this milestone" }
{ "action": "member_kill", "name": "alice" }
{ "action": "plan_approve", "name": "alice" }
```

## Commands

### Shortcuts

| Command | Description |
| --- | --- |
| `/swarm [task]` | Tell the agent to spawn a team and work on a task |
| `/tw` | Open the interactive widget panel |
| `/team-widget` | Open the interactive widget panel (alias for `/tw`) |

### Team management

All management commands live under `/team`.

| Command | Description |
| --- | --- |
| `/team spawn <name> [fresh\|branch] [shared\|worktree] [plan] [--model <provider>/<modelId>] [--thinking <level>]` | Start a teammate |
| `/team list` | List teammates and their status |
| `/team panel` | Interactive widget panel (same as `/tw`) |
| `/team attach list` | Discover existing team workspaces under `<teamsRoot>` |
| `/team attach <teamId> [--claim]` | Attach this session to an existing team workspace (`--claim` force-takes over an active claim) |
| `/team detach` | Return to this session's own team workspace |
| `/team style` | Show current style + usage |
| `/team style list` | List available styles (built-in + custom) |
| `/team style init <name> [extends <base>]` | Create a custom style template under `~/.pi/agent/teams/_styles/` |
| `/team style <name>` | Set style (built-in or custom) |
| `/team send <name> <msg>` | Send a prompt over RPC |
| `/team steer <name> <msg>` | Redirect an in-flight run |
| `/team dm <name> <msg>` | Send a mailbox message |
| `/team broadcast <msg>` | Message all teammates |
| `/team stop <name> [reason]` | Abort current work (resets task to pending) |
| `/team shutdown <name> [reason]` | Graceful shutdown (handshake) |
| `/team shutdown` | Stop all teammates (RPC + best-effort manual) (leader session remains active) |
| `/team prune [--all]` | Mark stale manual teammates offline (hides them in widget) |
| `/team kill <name>` | Force-terminate |
| `/team cleanup [--force]` | Delete team artifacts |
| `/team id` | Print team/task-list IDs and paths |
| `/team env <name>` | Print env vars to start a manual teammate |

### Panel shortcuts (`/tw` / `/team panel`)

- `↑/↓` or `w/s`: select teammate / scroll transcript
- `1..9`: jump directly to teammate in overview
- `enter`: open selected teammate transcript
- `t` or `shift+t`: open selected teammate task list (task-centric view with deps/blocks); in task view, toggle back (`esc`/`t`/`shift+t`)
- task view: `c` complete, `p` pending, `i` in-progress, `u` unassign, `r` reassign selected task
- `m` or `d`: compose message to selected teammate
- `a`: request abort
- `k`: kill (SIGTERM)
- `esc`: back/close panel
- attached mode shows a banner (`attached: ...`) with `/team detach` hint

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
| `PI_TEAMS_STYLE` | UI style id (built-in: `normal`, `soviet`, `pirate`, or custom) | `normal` |
| `PI_TEAMS_HOOKS_ENABLED` | Enable leader-side hooks/quality gates | `0` (off) |
| `PI_TEAMS_HOOKS_DIR` | Hooks directory (absolute or relative to `PI_TEAMS_ROOT_DIR`) | `<teamsRoot>/_hooks` |
| `PI_TEAMS_HOOK_TIMEOUT_MS` | Hook execution timeout (ms) | `60000` |
| `PI_TEAMS_HOOKS_CREATE_TASK_ON_FAILURE` | If `1`, create a follow-up task when a task hook fails | `0` (off) |

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

<teamsRoot>/_hooks/
  on_idle.{js,sh}                       # optional hook (see below)
  on_task_completed.{js,sh}             # optional quality gate
  on_task_failed.{js,sh}                # optional hook
```

## Hooks / quality gates (optional)

Enable hooks:

```bash
export PI_TEAMS_HOOKS_ENABLED=1
```

Then create hook scripts under:

- `<teamsRoot>/_hooks/` (default: `~/.pi/agent/teams/_hooks/`)

Recognized hook names:

- `on_idle.(js|mjs|sh)`
- `on_task_completed.(js|mjs|sh)`
- `on_task_failed.(js|mjs|sh)`

Hooks run with working directory = the **leader session cwd** and receive context via env vars:

- `PI_TEAMS_HOOK_EVENT`
- `PI_TEAMS_TEAM_ID`, `PI_TEAMS_TEAM_DIR`, `PI_TEAMS_TASK_LIST_ID`
- `PI_TEAMS_STYLE`
- `PI_TEAMS_MEMBER`
- `PI_TEAMS_TASK_ID`, `PI_TEAMS_TASK_SUBJECT`, `PI_TEAMS_TASK_OWNER`, `PI_TEAMS_TASK_STATUS`

If you want hook failures to create a follow-up task automatically:

```bash
export PI_TEAMS_HOOKS_CREATE_TASK_ON_FAILURE=1
```

## Development

### Quality gate

```bash
npm run check
```

Runs strict TypeScript typechecking (`npm run typecheck`) and ESLint (`npm run lint`).

### Smoke test (no API keys)

```bash
npm run smoke-test
# or: npx tsx scripts/smoke-test.mts
```

Filesystem-level smoke test of the task store, mailbox, team config, and protocol parsers.

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
