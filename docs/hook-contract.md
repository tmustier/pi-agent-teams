# Hook Contract

Versioned specification for the interface between pi-agent-teams and hook scripts.

Hook scripts are external programs (`.js`, `.mjs`, `.sh`, or bare executables) that run
on lifecycle events. This document defines what hooks receive and what pi-agent-teams
guarantees across releases.

## Current version

**Contract version: 1**

Exported as `HOOK_CONTRACT_VERSION` from `extensions/teams/hooks.ts`.

## Contract surface

Hooks receive context through two channels:

| Channel | Format | Key / field |
|---|---|---|
| Environment variable | string | `PI_TEAMS_HOOK_CONTEXT_VERSION` — the contract version as a string |
| Environment variable | JSON string | `PI_TEAMS_HOOK_CONTEXT_JSON` — structured payload (schema below) |
| Environment variables | flat strings | `PI_TEAMS_HOOK_EVENT`, `PI_TEAMS_TEAM_ID`, etc. (convenience) |
| Exit code | integer | `0` = pass, non-zero = fail |

### Context JSON schema (v1)

```jsonc
{
  "version": 1,                        // always matches PI_TEAMS_HOOK_CONTEXT_VERSION
  "event": "task_completed",           // "idle" | "task_completed" | "task_failed"
  "team": {
    "id": "<teamId>",
    "dir": "<absolute path>",
    "taskListId": "<taskListId>",
    "style": "normal"                  // current UI style id
  },
  "member": "<name>" | null,          // teammate that triggered the event
  "timestamp": "<ISO 8601>" | null,
  "task": {                            // null for "idle" events; may also be null
                                       // for task_completed/task_failed if the task
                                       // was cleared before the leader processed it
    "id": "3",
    "subject": "<text>",               // truncated to 1,000 chars
    "description": "<text>",           // truncated to 8,000 chars
    "owner": "<name>" | null,
    "status": "completed",             // "pending" | "in_progress" | "completed"
                                       // NOTE: for task_failed events the status is
                                       // typically "pending" (reset before hook runs)
    "blockedBy": ["1", "2"],           // max 200 entries
    "blocks": ["5"],                   // max 200 entries
    "metadata": {},                    // freeform key-value
    "createdAt": "<ISO 8601>",
    "updatedAt": "<ISO 8601>"
  }
}
```

### Flat environment variables (v1)

| Variable | Always set | Description |
|---|---|---|
| `PI_TEAMS_HOOK_EVENT` | ✓ | Event name |
| `PI_TEAMS_HOOK_CONTEXT_VERSION` | ✓ | Contract version (string) |
| `PI_TEAMS_HOOK_CONTEXT_JSON` | ✓ | Full JSON payload |
| `PI_TEAMS_TEAM_ID` | ✓ | Team identifier |
| `PI_TEAMS_TEAM_DIR` | ✓ | Absolute path to team directory |
| `PI_TEAMS_TASK_LIST_ID` | ✓ | Task list identifier |
| `PI_TEAMS_STYLE` | ✓ | UI style id |
| `PI_TEAMS_MEMBER` | when available | Teammate name |
| `PI_TEAMS_EVENT_TIMESTAMP` | when available | ISO 8601 event timestamp |
| `PI_TEAMS_TASK_ID` | when task exists | Task id |
| `PI_TEAMS_TASK_SUBJECT` | when task exists | Task subject (untruncated) |
| `PI_TEAMS_TASK_OWNER` | when task has owner | Task owner name |
| `PI_TEAMS_TASK_STATUS` | when task exists | Task status |

### Hook exit code semantics

| Exit code | Meaning | Leader behavior |
|---|---|---|
| `0` | Pass | Record success in task metadata |
| Non-zero | Fail | Apply failure policy (warn / followup / reopen / reopen_followup) |
| Timeout (SIGTERM) | Fail | Same as non-zero exit |

## Compatibility policy

### Additive changes (no version bump)

The following changes are **backward-compatible** and do NOT increment the contract version:

- Adding new **optional** fields to the context JSON (hooks must tolerate unknown keys)
- Adding new **environment variables** (hooks must tolerate new env vars)
- Adding new **event types** (hooks only receive events matching their filename)
- Extending `metadata` with new keys
- Increasing truncation limits

### Breaking changes (version bump required)

The following changes **require incrementing** the contract version:

- Removing or renaming existing JSON fields
- Changing the type of an existing field
- Changing the semantics of an existing field (e.g., status values)
- Reducing truncation limits below current values
- Changing exit code semantics
- Removing environment variables

### Version lifecycle

1. **New version**: old version continues to be supported for at least one minor release
2. **Deprecation**: the old version emits a warning in hook logs
3. **Removal**: the old version is dropped in the next major release

### Hook author guidelines

Write hooks that are resilient to additive changes and race conditions:

```js
// ✅ Good: parse only the fields you need, ignore the rest
const ctx = JSON.parse(process.env.PI_TEAMS_HOOK_CONTEXT_JSON);
const taskId = ctx.task?.id;

// ✅ Good: always guard task access — task can be null even for
// task_completed/task_failed events (race: task cleared before leader reads it)
if (!ctx.task) {
  console.log("Task already cleared, skipping quality gate");
  process.exit(0);
}

// ✅ Good: don't assume task.status matches the event name —
// for task_failed events the status is typically "pending" (reset before hook runs)
if (ctx.event === "task_failed") {
  console.log(`Task #${ctx.task.id} failed (current status: ${ctx.task.status})`);
}

// ✅ Good: check the version for breaking changes
const version = parseInt(process.env.PI_TEAMS_HOOK_CONTEXT_VERSION, 10);
if (version > 1) {
  console.error(`Unsupported hook contract version: ${version}`);
  process.exit(1);
}

// ❌ Bad: assume exact shape, fail on new fields
const { version, event, team, member, timestamp, task } = ctx;
assert(Object.keys(ctx).length === 5); // breaks when fields are added

// ❌ Bad: unconditionally access task fields
const subject = ctx.task.subject; // crashes when task is null
```

## Hook log format

Each hook invocation produces a log file in `<teamDir>/hook-logs/` with the structure:

```jsonc
{
  "invocation": {
    "event": "task_completed",
    "teamId": "...",
    // ... full invocation context
  },
  "result": {
    "ran": true,
    "hookPath": "/path/to/on_task_completed.js",
    "command": ["node", "/path/to/on_task_completed.js"],
    "exitCode": 0,
    "timedOut": false,
    "durationMs": 142,
    "stdout": "...",
    "stderr": "...",
    "contractVersion": 1           // traces which version was used
  }
}
```

## Changelog

### v1 (initial)

- Context JSON with `version`, `event`, `team`, `member`, `timestamp`, `task`
- Flat env vars: `PI_TEAMS_HOOK_EVENT`, `PI_TEAMS_HOOK_CONTEXT_VERSION`, `PI_TEAMS_HOOK_CONTEXT_JSON`, team/task fields
- Exit code 0 = pass, non-zero = fail
- Truncation: subject 1,000 chars, description 8,000 chars, blockedBy/blocks max 200 entries
