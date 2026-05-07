# Team Lead Messaging + Mailbox Lock Hardening Plan

## Context

A teammate was asked directly to message the team lead. Instead of using the Teams mailbox tool, it generated a Python script that manually edited `mailboxes/team/inboxes/team-lead.json` and created `team-lead.json.lock`. The message was delivered, but the extension later failed while sending an automatic idle notification because the leftover `.lock` file blocked `writeToMailbox()`.

A related orchestration issue appeared during investigation: delegating three explicitly-assigned tasks spawned three generic `agentN` teammates plus the three named assignees.

## Findings captured so far

- `extensions/teams/fs-lock.ts` uses exclusive lock-file creation (`fs.openSync(lockFilePath, "wx")`), not `fcntl`/OS advisory locks. Any existing `.lock` file blocks writers until it is considered stale.
- Default lock settings are `timeoutMs=10_000` and `staleMs=60_000`, so a freshly-abandoned foreign lock can cause repeated 10s failures for up to 60s.
- `extensions/teams/mailbox.ts` uses the same lock file for writes and pops: `<inbox>.json.lock`.
- `extensions/teams/worker.ts` registers only `team_message`, and its wording says “comrade”, “peers”, and “teammate-to-teammate”, which makes worker-to-lead messaging undiscoverable.
- `extensions/teams/leader-inbox.ts` already supports teammate-to-leader plain DMs by routing unrecognized messages as `[Team DM] <from>: <text>`.
- `team_message` can technically target `team-lead`, but it then also writes a redundant `peer_dm_sent` CC to the same leader inbox.
- `extensions/teams/leader.ts` appends only a minimal worker system prompt and does not tell workers how to contact the leader or warn against manual mailbox edits.
- `extensions/teams/leader-teams-tool.ts` auto-spawns generic teammates before considering per-task `assignee` fields, causing extra teammates when all tasks already have explicit assignees. Specifically, the delegate action only looks at `params.teammates` and existing `teammates.size` before auto-generating names at `leader-teams-tool.ts:1191-1215`; it does not seed `teammateNames` from `tasks[].assignee` until assignment creation at `1252-1268`, so my three explicitly assigned tasks first spawned `agent1/agent2/agent3`, then spawned `locksmith/messenger/ux-audit` while creating tasks.

## Approach

Implement a small, durable hardening pass that fixes the human-visible failure path and the underlying robustness issues:

1. Make worker-to-leader messaging first-class and discoverable with a dedicated tool and clearer prompts.
2. Harden mailbox locking against foreign/abandoned lock files without weakening normal extension-to-extension serialization.
3. Make worker idle notifications non-fatal if mailbox delivery still fails.
4. Fix delegate teammate resolution so explicit assignees do not trigger extra generic spawns; this directly covers the “why did you spawn 6 instead of 3?” incident.
5. Reduce leader-to-worker prompt/follow-up race failures where stale status leads to “already processing a prompt”.
6. Add smoke tests and docs drift checks so these behaviors do not regress.

## Files to modify

- `extensions/teams/worker.ts`
- `extensions/teams/fs-lock.ts`
- `extensions/teams/mailbox.ts`
- `extensions/teams/leader.ts`
- `extensions/teams/leader-inbox.ts`
- `extensions/teams/leader-teams-tool.ts`
- `extensions/teams/leader-messaging-commands.ts`
- `extensions/teams/activity-tracker.ts`
- `scripts/smoke-test.mts`
- `README.md`
- `docs/claude-parity.md`

## Reuse

- Reuse `sanitizeName()` from `extensions/teams/names.ts` for recipient/lead names.
- Reuse `writeToMailbox()` and `TEAM_MAILBOX_NS` for all worker-to-lead delivery.
- Reuse `pollLeaderInbox()`’s existing fallback DM path for plain worker-to-lead messages.
- Reuse `withLock()` for serialization, but extend its abandoned-lock detection instead of replacing the lock mechanism.
- Reuse existing smoke-test patterns in `scripts/smoke-test.mts` for fs-lock, mailbox, protocol, activity tracker, and docs drift guards.

## Steps

- [x] Add a `message_lead` worker tool in `extensions/teams/worker.ts` with parameters `{ message, urgent? }`; it writes one plain mailbox DM to `leadName`.
- [x] Update `team_message` wording to say it can message teammates, and that lead messages should use `message_lead`.
- [x] In `team_message`, skip the `peer_dm_sent` CC when `recipient === leadName` to avoid duplicate leader inbox writes and lock contention.
- [x] Update `leader-inbox.ts` so urgent worker-to-lead DMs use `deliverAs: "steer"`; normal DMs continue using the existing `[Team DM]` follow-up path.
- [x] Update the worker system prompt in `extensions/teams/leader.ts` to say: use `message_lead` to contact the leader, use Teams tools instead of editing mailbox files, and do not create `.lock` files manually.
- [x] Extend `withLock()` with optional abandoned-lock recovery: parse the JSON payload written by this extension, remove locks owned by dead PIDs, and remove invalid/foreign locks only after a short invalid-lock grace period so a just-created extension lock is not deleted while its payload is being written.
- [x] Pass mailbox-appropriate lock options from `writeToMailbox()` / `popUnreadMessages()` while keeping task/config locks conservative.
- [x] Wrap `sendIdleNotification()` mailbox writes in a bounded retry/best-effort catch so extension event handlers do not surface noisy lock exceptions.
- [x] Refactor delegate name planning in `leader-teams-tool.ts` into a small pure helper, then fix it to include explicit per-task assignees before auto-generating names and to generate only enough names for unassigned tasks. Example expected behavior: three tasks assigned to `locksmith`, `messenger`, and `ux-audit` should spawn exactly those three and no `agentN` extras.
- [x] Add a shared helper for leader-to-worker sends that retries `followUp()` if `prompt()` fails with an “already processing” style error; use it from `/team send` and the panel send path.
- [x] Add `message_lead` display support to `activity-tracker.ts`.
- [x] Add smoke tests covering foreign lock recovery, worker tool registration/execution with an `ExtensionAPI` stub, `message_lead` delivery through `pollLeaderInbox()`, no duplicate `peer_dm_sent` for `team_message` to `team-lead`, explicit-assignee delegate planning that proves 3 explicitly-assigned tasks spawn exactly 3 teammates, prompt-to-followUp retry behavior, and activity summary for `message_lead`.
- [x] Update README/docs to document worker-to-lead messaging and warn against manual mailbox JSON/lock edits.

## Verification

- Run `npm run typecheck`.
- Run `npm run lint`.
- Run `npm run smoke-test`.
- Manually smoke test in Pi:
  - spawn one teammate;
  - ask it to message the leader;
  - confirm it uses `message_lead`, no Python/manual mailbox edit appears, and the leader receives `[Team DM]`;
  - create a fresh bogus `team-lead.json.lock` in a temp team and confirm mailbox recovery does not produce a surfaced extension error;
  - delegate three tasks with explicit assignees and confirm only those three teammates spawn.
