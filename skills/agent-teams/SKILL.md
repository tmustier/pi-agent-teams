---
name: agent-teams
description: "Coordinate multi-agent teamwork with shared task lists, mailbox messaging, and long-lived teammates. Use when the user asks to spawn workers, delegate tasks, work in parallel with agents, or manage a team of workers."
---

# Agent Teams

Spawn and coordinate teammate agents that work in parallel on shared task lists, communicating via file-based mailboxes. Modeled after Claude Code Agent Teams.

## Core concepts

- **Leader** (you): orchestrates, delegates, reviews. Runs the `/team` command and the `teams` LLM tool.
- **Teammates**: child Pi processes that poll for tasks, execute them, and report back. Sessions are named `pi agent teams - teammate <name>` (or `... - comrade <name>` in soviet style).
- **Task list**: file-per-task store with statuses (pending/in_progress/completed), owners, and dependency tracking.
- **Mailbox**: file-based message queue. Two namespaces: `team` (DMs, notifications, shutdown) and `taskListId` (task assignments).

## UI style

Two styles:
- `normal` (default): Team leader + Teammate <name>
- `soviet`: Chairman + Comrade <name> (the system decides names for you — run `/team spawn` without a name)

Configure via `PI_TEAMS_STYLE=normal|soviet` or `/team style <normal|soviet>`.

## Spawning teammates

Use the **`teams` tool** (LLM-callable) for the common case of delegating work:

```
teams({ action: "delegate", tasks: [{ text: "Implement auth", assignee: "alice" }] })
```

This spawns teammates as needed, creates tasks, and assigns them. Options: `contextMode` ("fresh" or "branch"), `workspaceMode` ("shared" or "worktree").

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
/team dm <name> <msg...>       # direct message to one teammate
/team broadcast <msg...>       # message all teammates
/team send <name> <msg...>     # RPC-based (immediate, for spawned teammates)
```

Teammates can also message each other directly via the `team_message` tool, with the leader CC'd.

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
/team shutdown <name>          # graceful shutdown (teammate can reject if busy)
/team kill                     # force kill all RPC teammates
/team cleanup [--force]        # delete team directory after all teammates stopped
```

Teammates reject shutdown requests when they have an active task. Use `/team kill` to force.

## Other commands

```
/team id       # show team ID, task list ID, paths
/team env <n>  # print env vars for manually spawning a teammate named <n>
```

## Shared task list across sessions

Set `PI_TEAMS_TASK_LIST_ID` env to reuse tasks across team sessions. Or switch mid-session:

```
/team task use my-persistent-list
```

Teammates spawned after the switch inherit the new task list ID.

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
