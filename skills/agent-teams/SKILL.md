---
name: agent-teams
description: "Coordinate multi-agent teamwork with shared task lists, mailbox messaging, and long-lived teammates. Use when the user asks to spawn workers, delegate tasks, work in parallel with agents, or manage a team of workers."
---

# Agent Teams

Spawn and coordinate teammate agents that work in parallel on shared task lists, communicating via file-based mailboxes. Modeled after Claude Code Agent Teams.

## Core concepts

- **Leader** (you): orchestrates, delegates, reviews. Runs the `/team` command and the `teams` LLM tool.
- **Teammates**: child Pi processes that poll for tasks, execute them, and report back. Sessions are named `pi agent teams - <role> <name>` where `<role>` depends on the current style (e.g. teammate/comrade/matey).
- **Task list**: file-per-task store with statuses (pending/in_progress/completed), owners, and dependency tracking.
- **Mailbox**: file-based message queue. Two namespaces: `team` (DMs, notifications, shutdown) and `taskListId` (task assignments).

## UI style (terminology + naming)

Built-in styles:
- `normal` (default): Team leader + Teammate <name>
- `soviet`: Chairman + Comrade <name>
- `pirate`: Captain + Matey <name>

Configure via `PI_TEAMS_STYLE=<name>` or `/team style <name>` (see `/team style list`).

Custom styles can be added via JSON files under `~/.pi/agent/teams/_styles/<style>.json` or bootstrapped with:

- `/team style init <name> [extends <base>]`

## Spawning teammates

Use the **`teams` tool** (LLM-callable) for delegation, task/messaging mutations, lifecycle, and governance:

| Action | Required fields | Notes |
| --- | --- | --- |
| `delegate` | `tasks` | Spawns as needed, creates and assigns tasks. |
| `task_assign` | `taskId`, `assignee` | Assign/reassign owner. |
| `task_unassign` | `taskId` | Clear owner. |
| `task_set_status` | `taskId`, `status` | `pending` \| `in_progress` \| `completed`. |
| `task_dep_add` / `task_dep_rm` | `taskId`, `depId` | Dependency graph edits. |
| `task_dep_ls` | `taskId` | Dependency/block inspection. |
| `message_dm` | `name`, `message` | Mailbox DM. `urgent=true` interrupts active turns. |
| `message_broadcast` | `message` | Mailbox broadcast. `urgent=true` interrupts active turns. |
| `message_steer` | `name`, `message` | RPC steer for running teammate. |
| `member_spawn` | `name` | Supports context/workspace/model/thinking/plan options. |
| `member_shutdown` | `name` or `all=true` | Graceful mailbox shutdown request. |
| `member_kill` | `name` | Force-stop RPC teammate. |
| `member_prune` | _(none)_ | Mark stale workers offline (`all=true` to force). |
| `plan_approve` / `plan_reject` | `name` | Resolve pending plan approvals (`feedback` optional for reject). |
| `hooks_policy_get` | _(none)_ | Read team hooks policy (configured + effective). |
| `hooks_policy_set` | one or more: `hookFailureAction`, `hookMaxReopensPerTask`, `hookFollowupOwner` | Update team hooks policy at runtime (`hooksPolicyReset=true` clears team overrides first). |
| `model_policy_get` | _(none)_ | Inspect teammate model policy and current leader inheritance behavior. |
| `model_policy_check` | optional `model` | Validate a model override before spawn (`<provider>/<modelId>` or `<modelId>`). |

Examples:

```
teams({ action: "delegate", tasks: [{ text: "Implement auth", assignee: "alice" }] })
teams({ action: "task_assign", taskId: "12", assignee: "alice" })
teams({ action: "task_dep_add", taskId: "12", depId: "7" })
teams({ action: "message_broadcast", message: "Sync: finishing this milestone" })
teams({ action: "message_dm", name: "alice", message: "Stop using lib X, use Y instead", urgent: true })
teams({ action: "member_kill", name: "alice" })
teams({ action: "plan_reject", name: "alice", feedback: "Include rollback strategy" })
teams({ action: "hooks_policy_get" })
teams({ action: "hooks_policy_set", hookFailureAction: "reopen_followup", hookMaxReopensPerTask: 2, hookFollowupOwner: "member" })
teams({ action: "model_policy_get" })
teams({ action: "model_policy_check", model: "openai-codex/gpt-5.1-codex-mini" })
```

This covers most day-to-day orchestration without slash commands. For nuanced/manual control, use `/team ...` commands directly.

For more control, use `/team spawn`:

```
/team spawn alice              # default: fresh context, shared workspace
/team spawn bob branch shared  # clone leader session context
/team spawn carol fresh worktree  # git worktree isolation
/team spawn dave plan          # plan-required mode (read-only until approved)
```

## Task management

```
/team task add <text...>                # create a task
/team task add alice: review the API    # create + assign (prefix with name:)
/team task assign <id> <agent>          # assign existing task
/team task unassign <id>                # unassign
/team task list                         # show all tasks with status + deps
/team task show <id>                    # full task details + result
/team task dep add <id> <depId>         # task depends on depId
/team task dep rm <id> <depId>          # remove dependency
/team task dep ls <id>                  # show dependency graph
/team task clear [completed|all]        # delete tasks
/team task use <taskListId>             # switch to a different task list
```

Teammates auto-claim unassigned, unblocked tasks by default.

## Communication

```
/team dm <name> <msg...>              # direct message to one teammate
/team dm <name> --urgent <msg...>     # urgent DM — interrupts active turn via steering
/team broadcast <msg...>              # message all teammates
/team broadcast --urgent <msg...>     # urgent broadcast — interrupts all active turns
/team send <name> <msg...>            # RPC-based (immediate, for spawned teammates)
```

Urgent messages (`--urgent` or `urgent=true` in tool calls) interrupt a teammate's active turn via steering instead of waiting for idle. Use sparingly — only for time-sensitive coordination like "stop using library X, it's broken".

Teammates can also message each other directly via the `team_message` tool (with optional `urgent` flag), with the leader CC'd.

## Governance modes

### Delegate mode

Restricts the leader to coordination-only (blocks bash/edit/write tools). Use when you want to force all implementation through teammates.

```
/team delegate on    # enable
/team delegate off   # disable
```

### Plan approval

Spawning with `plan` restricts the teammate to read-only tools. After producing a plan, the teammate submits it for leader approval before proceeding.

```
/team spawn alice plan         # spawn in plan-required mode
/team plan approve alice       # approve plan, teammate gets full tools
/team plan reject alice <feedback...>  # reject, teammate revises
```

## Lifecycle

```
/team panel                    # interactive overlay with teammate details
/team list                     # show teammates and their state
/team attach list              # discover existing teams under <teamsRoot>
/team attach <teamId> [--claim] # attach this session to an existing team workspace (force takeover with --claim)
/team detach                   # return to this session's own team workspace
/team shutdown                 # stop all teammates (RPC + best-effort manual) (leader session remains active)
/team shutdown <name>          # graceful shutdown (teammate can reject if busy)
/team prune [--all]            # hide stale manual teammates (mark offline in config)
/team kill <name>              # force-terminate one RPC teammate
/team cleanup [--force]        # delete team directory, worktrees, and branches
/team gc [--dry-run] [--force] [--max-age-hours=N]  # garbage-collect stale team dirs
```

Teammates reject shutdown requests when they have an active task. Use `/team kill <name>` to force.

## Cleanup

Worktrees and branches are automatically cleaned up on session shutdown and session switch. For manual cleanup:

- `/team cleanup [--force]` — removes the current team directory, including git worktrees and associated branches. Reports removal counts.
- `/team gc [--dry-run] [--force] [--max-age-hours=N]` — garbage-collects stale team directories older than `N` hours (default: 24). Skips teams with online members or in-progress tasks. Use `--dry-run` to preview.

## Other commands

```
/team id       # show team ID, task list ID, paths
/team env <n>  # print env vars for manually spawning a teammate named <n>
```

## Shared task list across sessions

`PI_TEAMS_TASK_LIST_ID` is primarily **worker-side** (use it when you start a teammate manually).

The leader switches task lists via:

```
/team task use my-persistent-list
```

The chosen task list ID is persisted in `config.json`. Teammates spawned after the switch inherit the new task list ID; existing teammates need a restart to pick up changes.

## Message protocol

Teammates and the leader communicate via JSON messages with a `type` field:

| Type | Direction | Purpose |
|---|---|---|
| `task_assignment` | leader -> teammate | Notify of assigned task |
| `idle_notification` | teammate -> leader | Teammate finished, no more work |
| `shutdown_request` | leader -> teammate | Ask to shut down |
| `shutdown_approved` | teammate -> leader | Will shut down |
| `shutdown_rejected` | teammate -> leader | Busy, can't shut down now |
| `plan_approval_request` | teammate -> leader | Plan ready for review |
| `plan_approved` | leader -> teammate | Proceed with implementation |
| `plan_rejected` | leader -> teammate | Revise plan (includes feedback) |
| `peer_dm_sent` | teammate -> leader | CC notification of peer message |
