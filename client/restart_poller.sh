#!/bin/bash
# Restart the poller — run it whether or not the poller is currently running.
# Works from ANY folder (resolves its own location). Re-login uses the saved
# session (state/session.json) — the password is not needed to restart.
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE" || exit 1
pkill -f "poller.py" || true
sleep 1
mkdir -p state
nohup python3 poller.py >> state/poller.log 2>&1 &
echo "poller restarted pid=$!"
