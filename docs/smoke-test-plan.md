# pi-agent-teams — Runtime Smoke Test Plan

## Prerequisites

- `pi` CLI installed (`pi --version` → `0.52.x+`)
- `node_modules/` present (run `npm install` or symlink from main repo)
- `npx tsx` available for running `.mts` test scripts

## 1. Automated Unit Smoke Test (no interactive session)

Exercises all core primitives directly via `tsx`:

```bash
npx tsx scripts/smoke-test.mts
# or: npm run smoke-test
```

**What it tests** (overview):

| Module           | Coverage                                                        |
|------------------|-----------------------------------------------------------------|
| `names.ts`       | `sanitizeName` character replacement, edge cases                |
| `model-policy.ts`| Deprecated model detection, teammate model selection/override   |
| `teams-ui-shared.ts` | `isTeamDone` (9 edge cases), display helpers                |
| `fs-lock.ts`     | `withLock` returns value, cleans up lock file, stale locks      |
| `mailbox.ts`     | `writeToMailbox`, `popUnreadMessages`, read-once, urgent flag   |
| `task-store.ts`  | CRUD, `startAssignedTask`, `completeTask`, `claimNextAvailable`,|
|                  | `unassignTasksForAgent`, dependencies, `clearTasks`             |
| `team-config.ts` | `ensureTeamConfig` (idempotent), `upsertMember`, `setMemberStatus`, `loadTeamConfig`, hooks policy |
| `protocol.ts`    | Structured message parsers (valid + invalid JSON + wrong type)  |
| `teams-style.ts` | Custom styles, naming rules, pool naming                        |
| `hooks.ts`       | Hook execution, failure policies, follow-up/reopen actions      |
| `team-attach-claim.ts` | Acquire/release/heartbeat claims, staleness detection     |
| `team-discovery.ts` | Team listing, config parsing, online worker counts           |
| `/team done`     | End-of-run cleanup, force-done with in-progress tasks, idempotency |
| `isTeamDone`     | All branches: empty, completed, pending, streaming, stopped     |
| docs drift guard | README, SKILL.md, help text consistency checks                  |
| Pi CLI           | `pi --version` executes (skipped in CI if `pi` not on PATH)    |

**Expected result:** `PASSED: <n>  FAILED: 0`

## 2. Extension Loading Test

Verify Pi can load the extension entry point without crashing:

```bash
pi --no-extensions -e extensions/teams/index.ts --help
```

**Expected:** exits 0, shows Pi help output (no TypeScript/import errors).

## 3. Interactive Smoke Test (manual)

### 3a. Launch Pi with the extension

```bash
# From the repo root:
pi --no-extensions -e extensions/teams/index.ts
```

Or, if the extension is symlinked into `~/.pi/agent/extensions/pi-agent-teams`:

```bash
pi   # auto-loads from extensions dir
```

### 3b. Check extension is active

```
/team help
```

**Expected:** shows usage lines for `/team spawn`, `/team task`, etc.

### 3c. Spawn a teammate ("comrade" in soviet style)

```
/team spawn agent1 fresh shared
```

**Expected:** notification "Spawned agent1" or similar, widget shows `Teammate agent1: idle` (or `Comrade agent1: idle` in soviet style).

### 3d. Create and assign a task

```
/team task add agent1: Say hello
/team task list
```

**Expected:** task #1 created, assigned to agent1, status `pending` → `in_progress`.

### 3e. Verify mailbox delivery

```
/team dm agent1 ping from lead
```

**Expected:** "DM queued for agent1" notification.

### 3f. Delegate via tool

Ask the model:
> "Delegate a task to agent1: write a haiku about coding"

**Expected:** the `teams` tool is invoked, task created and assigned.

### 3g. End of run

```
/team done
```

**Expected:** all teammates stopped, widget hidden, summary notification shows task counts. If tasks are still in progress, use `/team done --force`.

After `/team done`, spawning a new teammate should automatically restore the widget.

### 3h. Shutdown (alternative to done)

```
/team shutdown agent1
/team kill agent1
```

**Expected:** agent1 goes offline, widget updates.

Optional: stop all teammates without ending the leader session:

```
/team shutdown
```

**Expected:** all teammates stop; leader remains active until you exit it (e.g. ctrl+d).

If old/manual teammates still show as idle (stale config entries), prune them:

```
/team prune
# or: /team prune --all
```

## 4. Worker-side Smoke (verifying child process)

To test the worker role directly:

```bash
PI_TEAMS_WORKER=1 \
PI_TEAMS_TEAM_ID=test-team \
PI_TEAMS_AGENT_NAME=agent1 \
PI_TEAMS_LEAD_NAME=team-lead \
PI_TEAMS_STYLE=normal \
pi --no-extensions -e extensions/teams/index.ts --mode rpc
```

**Expected:** process starts in RPC mode, registers `team_message` tool, polls mailbox.

## 5. Checklist Summary

| # | Test                          | Method     | Status |
|---|-------------------------------|------------|--------|
| 1 | Unit primitives (200+ asserts)| Automated  | ✅     |
| 2 | Extension loading             | CLI        | ✅     |
| 3 | Interactive spawn/task/dm/done| Manual     | 📋     |
| 4 | Worker-side RPC               | Manual     | 📋     |

✅ = verified in this run, 📋 = documented for manual execution.
