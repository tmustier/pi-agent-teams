# AGENTS.md

Project-specific guidance for AI agents working in this repository.

## Operating Intent (Critical)

This project is **agent-driven**, not user-operated.

- Treat the human as setting goals/outcomes, not executing operational steps.
- Prefer autonomous agent flows (tool actions, policies, retries, task transitions).
- Do **not** rely on manual user remediation as the default path.
- UI panels and slash commands are primarily for observability/debugging and emergency override.
- Quality-gate failures should be handled by agent policy (warn/followup/reopen/reopen_followup), not by asking the user to manually clear state.
- Human-in-the-loop steps should happen only when explicitly required by policy or requested by the user.
