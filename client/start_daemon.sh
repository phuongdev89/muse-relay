#!/bin/bash
# Start the daemon once — only when it is not already running; leave it alone if it is.
# Used by Muse's 3-minute schedule. Works from ANY folder (resolves its own location).
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE" || exit 1
if pgrep -f "poller.py" > /dev/null; then
  echo "daemon is already running, not starting it again"
  exit 0
fi
mkdir -p state
nohup python3 poller.py >> state/poller.log 2>&1 &
echo "daemon started pid=$!"
