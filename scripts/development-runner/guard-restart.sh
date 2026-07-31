#!/usr/bin/env bash
#
# Preflight guard for restarting the openryoko gateway.
#
# A `systemctl restart openryoko` kills the whole service cgroup, which
# includes any development runner the gateway started through sudo. The runner
# then leaves its fail-closed lock behind and later /vibepro requests fail.
# Run this guard BEFORE restarting; it exits 0 only when no development run
# is active.
#
# Usage (on the pilot host, as root):
#   sudo ./guard-restart.sh              # fail immediately if a run is active
#   sudo ./guard-restart.sh --wait 5400  # wait up to 90 min for the run to end
#
# Exit codes: 0 = safe to restart, 1 = a run is active (or wait timed out),
#             2 = usage error.
#
# Root is required in practice: the lock lives under /home/ryoko-dev and
# liveness checks must see ryoko-dev's processes.
set -euo pipefail

LOCK_PATH="${OPENRYOKO_DEV_LOCK:-/home/ryoko-dev/.openryoko-development-runner.lock}"
DEV_USER="${OPENRYOKO_DEV_USER:-ryoko-dev}"
POLL_SECONDS="${OPENRYOKO_GUARD_POLL_SECONDS:-10}"
WAIT_SECONDS=0

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)
      WAIT_SECONDS="${2:?--wait requires SECONDS}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

# Prints one of: idle / active / stale.
# "active" is the fail-closed default: an unreadable owner file or any
# surviving process of the development user blocks the restart.
lock_state() {
  if [[ ! -d "$LOCK_PATH" ]]; then
    echo idle
    return
  fi
  local owner
  owner="$(tr -d '[:space:]' < "$LOCK_PATH/owner" 2>/dev/null || true)"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
    echo active
    return
  fi
  if pgrep -u "$DEV_USER" >/dev/null 2>&1; then
    echo active
    return
  fi
  echo stale
}

deadline=$(( $(date +%s) + WAIT_SECONDS ))
notified=0
while true; do
  state="$(lock_state)"
  case "$state" in
    idle)
      echo "openryoko-dev guard: no development run is active. Safe to restart openryoko."
      exit 0
      ;;
    stale)
      echo "openryoko-dev guard: stale lock at $LOCK_PATH (owner dead, no $DEV_USER processes remain). The runner reclaims it automatically on its next start. Safe to restart openryoko."
      exit 0
      ;;
    active)
      if (( $(date +%s) >= deadline )); then
        echo "openryoko-dev guard: a development run is active (lock: $LOCK_PATH). Do NOT restart openryoko now. Retry with --wait SECONDS or after the run finishes." >&2
        exit 1
      fi
      if (( notified == 0 )); then
        echo "openryoko-dev guard: development run active; waiting for it to finish..." >&2
        notified=1
      fi
      sleep "$POLL_SECONDS"
      ;;
  esac
done
