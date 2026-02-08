---
name: agent-teams
description: "Coordinate multi-agent teamwork with shared task lists, mailbox messaging, and long-lived comrades. Use when the user asks to spawn comrades, delegate tasks, work in parallel with agents, or manage a team of workers."
---

# Agent Teams

Spawn and coordinate comrade agents that work in parallel on shared task lists, communicating via file-based mailboxes. Modeled after Claude Code Agent Teams.

## Core concepts

- **Chairman** (you): orchestrates, delegates, reviews. Runs the `/team` command and the `teams` LLM tool.
- **Comrades**: child Pi processes that poll for tasks, execute them, and report back. Each comrade's session is named `pi agent teams - comrade <name>`.
- **Task list**: file-per-task store with statuses (pending/in_progress/completed), owners, and dependency tracking.
- **Mailbox**: file-based message queue. Two namespaces: `team` (DMs, notifications, shutdown) and `taskListId` (task assignments).

## Spawning comrades

Use the **`teams` tool** (LLM-callable) for the common case of delegating work:

```
teams({ action: "delegate", tasks: [{ text: "Implement auth", assignee: "alice" }] })
```

This spawns comrades as needed, creates tasks, and assigns them. Options: `contextMode` ("fresh" or "branch"), `workspaceMode` ("shared" or "worktree").

For more control, use `/team spawn`:

```
/team spawn alice              # default: fresh context, shared workspace
/team spawn bob branch shared  # clone chairman session context
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

Comrades auto-claim unassigned, unblocked tasks by default.

## Communication

```
/team dm <name> <msg...>       # direct message to one comrade
/team broadcast <msg...>       # message all comrades
/team send <name> <msg...>     # RPC-based (immediate, for spawned comrades)
```

Comrades can also message each other directly via the `team_message` tool, with the chairman CC'd.

## Governance modes

### Delegate mode

Restricts the chairman to coordination-only (blocks bash/edit/write tools). Use when you want to force all implementation through comrades.

```
/team delegate on    # enable
/team delegate off   # disable
```

### Plan approval

Spawning with `plan` restricts the comrade to read-only tools. After producing a plan, the comrade submits it for chairman approval before proceeding.

```
/team spawn alice plan         # spawn in plan-required mode
/team plan approve alice       # approve plan, comrade gets full tools
/team plan reject alice <feedback...>  # reject, comrade revises
```

## Lifecycle

```
/team panel                    # interactive overlay with comrade details
/team status                   # show comrades and their state
/team shutdown <name>          # graceful shutdown (comrade can reject if busy)
/team kill                     # force kill all RPC comrades
/team cleanup [--force]        # delete team directory after all comrades stopped
```

Comrades reject shutdown requests when they have an active task. Use `/team kill` to force.

## Other commands

```
/team id       # show team ID, task list ID, paths
/team env <n>  # print env vars for manually spawning a comrade named <n>
```

## Shared task list across sessions

Set `PI_TEAMS_TASK_LIST_ID` env to reuse tasks across team sessions. Or switch mid-session:

```
/team task use my-persistent-list
```

Comrades spawned after the switch inherit the new task list ID.

## Message protocol

Comrades and chairman communicate via JSON messages with a `type` field:

| Type | Direction | Purpose |
|---|---|---|
| `task_assignment` | chairman -> comrade | Notify of assigned task |
| `idle_notification` | comrade -> chairman | Comrade finished, no more work |
| `shutdown_request` | chairman -> comrade | Ask to shut down |
| `shutdown_approved` | comrade -> chairman | Will shut down |
| `shutdown_rejected` | comrade -> chairman | Busy, can't shut down now |
| `plan_approval_request` | comrade -> chairman | Plan ready for review |
| `plan_approved` | chairman -> comrade | Proceed with implementation |
| `plan_rejected` | chairman -> comrade | Revise plan (includes feedback) |
| `peer_dm_sent` | comrade -> chairman | CC notification of peer message |
