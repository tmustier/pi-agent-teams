# pi-teams (extension)

This directory contains the **Teams** extension entrypoint:

- `index.ts` (leader/worker dispatch)

The full project README (usage, commands, tests) lives at the repo root:

- `../../README.md`

## Storage root override

By default, all Teams artifacts are stored under the Pi agent directory:

- `~/.pi/agent/teams/<teamId>/...`

For tests/CI (or if you want to keep Teams state separate), set:

- `PI_TEAMS_ROOT_DIR=/absolute/path`

Then the extension will store:

- `<PI_TEAMS_ROOT_DIR>/<teamId>/...`
