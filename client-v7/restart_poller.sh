#!/bin/bash
# Restart the poller — run it whether or not the poller is currently running.
# Works from ANY folder (resolves its own location). Re-login uses the saved
# session (state/session.json) — no password or key is needed to restart.
# The old poller is stopped by the PID recorded in state/puller.lock — never
# by pkill on a name pattern, which could kill an unrelated process.
# Set HELPER_PATH to override the folder (rare; normally leave it unset).
BASE="${HELPER_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$BASE" || exit 1
PY="python3"
if [ -x ".venv/bin/python" ]; then PY=".venv/bin/python"; fi
if [ -f state/puller.lock ]; then
  OLD_PID="$(cat state/puller.lock 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f state/puller.lock
fi
mkdir -p state
# No nohup: the scheduled task (setup_guide.txt STEP 6) is the supervisor.
"$PY" poller.py >> state/poller.log 2>&1 &
echo "poller restarted pid=$!"
