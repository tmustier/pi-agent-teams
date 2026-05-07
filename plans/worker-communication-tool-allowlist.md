# Worker Communication Tool Allowlist Plan

## Context

A teammate was asked to send `hello` to the team lead. It read the Teams skill and source, found the intended worker-side `message_lead` tool, but did not call it directly. Instead it launched a nested `pi --no-builtin-tools --tools message_lead ...` process from `bash`.

The root cause appears to be spawn-time tool allowlisting: the leader passes a `--tools` list containing only built-in tools, and Pi treats `--tools` as an allowlist for all tools, including extension tools. That makes worker extension tools such as `message_lead` and `team_message` unavailable in the primary teammate process.

## Goal

Teammates should be able to contact the team lead and other teammates through their first-class worker tools without shell hacks, nested Pi processes, manual mailbox edits, or user intervention.

## Findings

- `extensions/teams/worker.ts` registers `message_lead` and `team_message` correctly.
- `extensions/teams/leader.ts` appends worker instructions that tell teammates to use `message_lead`.
- `extensions/teams/leader.ts` currently builds child process args with only built-in tool names:
  - `read`
  - `bash`
  - `edit`
  - `write`
  - `grep`
  - `find`
  - `ls`
- Pi documentation confirms `--tools` / `setActiveTools()` applies to built-in, extension, and custom tools.
- Worker plan-required mode also calls `pi.setActiveTools(["read", "grep", "find", "ls"])`, which would hide communication tools even after fixing spawn args.

## Approach

Make communication tools part of the worker tool policy, not merely prompt guidance.

1. Define worker communication tool constants in a small shared module or near the spawn logic:
   - `message_lead`
   - `team_message`
2. When spawning a teammate, include those worker communication tools in the child `--tools` allowlist whenever an allowlist is passed.
3. Keep inherited built-in tool restrictions intact:
   - if the leader has no `edit`/`write`, do not add them for the worker;
   - only add communication tools as safe coordination tools.
4. Update worker plan-required mode to keep `message_lead` and `team_message` active while still disabling mutation tools.
5. Add tests that prove the intended tool list includes communication tools and that plan mode does not disable them.
6. Add a manual smoke test for the exact failure case.

## Files to modify

- `extensions/teams/leader.ts`
- `extensions/teams/worker.ts`
- potentially a new helper module, e.g. `extensions/teams/worker-tools.ts`
- `scripts/smoke-test.mts`
- optional docs update if behavior should be documented in `README.md` / `skills/agent-teams/SKILL.md`

## Implementation steps

- [ ] Add a shared constant for worker communication tools: `message_lead`, `team_message`.
- [ ] Add a helper such as `buildWorkerToolAllowlist(activeTools)` that:
  - preserves active built-in tools from the leader;
  - appends worker communication tools once;
  - avoids duplicate names;
  - preserves existing ordering for built-ins.
- [ ] Replace the inline `builtInToolSet` / `tools` logic in `extensions/teams/leader.ts` with the helper.
- [ ] Update worker plan-required mode in `extensions/teams/worker.ts` so read-only plan tools include `message_lead` and `team_message`.
- [ ] Update the worker plan-approval restore fallback to include communication tools in its default restored set.
- [ ] Add smoke tests for:
  - normal active tools produce `read,bash,edit,write,...,message_lead,team_message`;
  - restricted active tools do not gain mutation tools;
  - communication tools are present even when only read-only tools are active;
  - plan-required mode calls `setActiveTools()` with communication tools included.
- [ ] Run verification.

## Verification

Automated:

```bash
npm run typecheck
npm run lint
npm run smoke-test
```

Manual Pi smoke test:

1. Spawn one teammate.
2. Ask it: `send hello to the team lead`.
3. Confirm the teammate directly calls `message_lead`.
4. Confirm the leader receives `[Team DM] alice: hello`.
5. Confirm no nested `pi --tools message_lead` command or manual mailbox edit appears in the teammate transcript.

## Acceptance criteria

- A freshly spawned teammate can directly use `message_lead`.
- A plan-required teammate can still message the lead while in read-only mode.
- Built-in tool restrictions inherited from the leader remain respected.
- The exact observed failure path no longer requires a shell workaround.
