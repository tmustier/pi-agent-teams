#!/usr/bin/env bash
set -euo pipefail

# Start a Pi Teams leader + N worker sessions inside tmux.
#
# This is primarily a dogfooding helper so we can run a "Claude-like" split-pane
# setup (leader + interactive workers) while still using the same filesystem
# primitives (task list + mailboxes).
#
# Usage:
#   ./scripts/start-tmux-team.sh [session-name] [worker1 worker2 ...]
#
# Example:
#   ./scripts/start-tmux-team.sh pi-teams alice bob carol

SESSION_NAME=${1:-pi-teams}
shift || true

WORKERS=("$@")
if [[ ${#WORKERS[@]} -eq 0 ]]; then
  WORKERS=("alice" "bob")
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
EXT_ENTRY="${REPO_DIR}/extensions/teams/index.ts"

if [[ ! -f "${EXT_ENTRY}" ]]; then
  echo "ERROR: extension entry not found: ${EXT_ENTRY}" >&2
  exit 1
fi

# Use a fresh temp root per run unless the caller provided one.
TEAMS_ROOT=${PI_TEAMS_ROOT_DIR:-"/tmp/pi-teams-$(date +%Y%m%d-%H%M%S)"}
mkdir -p "${TEAMS_ROOT}"

# If the session already exists, refuse (avoid clobbering a running team).
if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "ERROR: tmux session already exists: ${SESSION_NAME}" >&2
  echo "Attach with: tmux attach -t ${SESSION_NAME}" >&2
  exit 1
fi

echo "Starting leader..."
# Leader (interactive)
tmux new-session -d -s "${SESSION_NAME}" -c "${REPO_DIR}" \
  "PI_TEAMS_ROOT_DIR=${TEAMS_ROOT} pi -e ${EXT_ENTRY}"

# Wait for the leader to create the team directory.
TEAM_ID=""
for _ in {1..80}; do
  # First directory directly under TEAMS_ROOT.
  TEAM_DIR=$(find "${TEAMS_ROOT}" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null || true)
  if [[ -n "${TEAM_DIR}" ]]; then
    TEAM_ID=$(basename "${TEAM_DIR}")
    break
  fi
  sleep 0.25
done

if [[ -z "${TEAM_ID}" ]]; then
  echo "ERROR: timed out waiting for team directory under ${TEAMS_ROOT}" >&2
  echo "Check leader pane: tmux attach -t ${SESSION_NAME}" >&2
  exit 1
fi

echo "TeamId: ${TEAM_ID}"

echo "Starting workers: ${WORKERS[*]}"
for name in "${WORKERS[@]}"; do
  # Each worker is an interactive pi session running the extension in worker mode.
  tmux new-window -t "${SESSION_NAME}" -n "${name}" -c "${REPO_DIR}" \
    "PI_TEAMS_ROOT_DIR=${TEAMS_ROOT} PI_TEAMS_WORKER=1 PI_TEAMS_TEAM_ID=${TEAM_ID} PI_TEAMS_AGENT_NAME=${name} pi -e ${EXT_ENTRY}"
done

cat <<EOF

OK

tmux session: ${SESSION_NAME}
teams root:   ${TEAMS_ROOT}
team id:      ${TEAM_ID}

Attach:
  tmux attach -t ${SESSION_NAME}

In the leader pane, try:
  /team help
  /team task add ${WORKERS[0]}: say hello
  /team task list
EOF
