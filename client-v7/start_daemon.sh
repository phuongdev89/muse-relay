#!/bin/bash
# Start the daemon once — only when it is not already running; leave it alone if it is.
# Used by Muse's 3-minute schedule. Works from ANY folder (resolves its own location).
# Set HELPER_PATH to override the folder (rare; normally leave it unset).
BASE="${HELPER_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$BASE" || exit 1
PY="python3"
if [ -x ".venv/bin/python" ]; then PY=".venv/bin/python"; fi
if pgrep -f "^${PY} poller\.py$" > /dev/null || pgrep -f '^python3 poller\.py$' > /dev/null; then
  echo "daemon is already running, not starting it again"
  exit 0
fi
mkdir -p state
# No nohup/cron/systemd: the scheduled task (setup_guide.txt STEP 6) is the
# supervisor. This script only starts the daemon when it is not running.
"$PY" poller.py >> state/poller.log 2>&1 &
echo "daemon started pid=$!"
