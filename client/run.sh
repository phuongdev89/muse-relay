#!/usr/bin/env bash
# ============================================================
#  Muse Relay — run the client on the Muse machine (Linux/macOS)
#
#  Usage:
#      bash run.sh
#
#  What the script does:
#    1. cd into the folder containing this script (where muse_client.py
#       and config.json live). The relay password comes only from the
#       MUSE_PASSWORD environment variable (secure form) or the saved session.
#    2. If there is no .venv yet: create a venv and install
#       requirements.txt (first run only).
#    3. Run muse_client.py in a restart loop: if the client exits or
#       dies, wait 5 seconds and run it again.
#
#  To stop completely: press Ctrl+C (the client exits cleanly).
#  Note: run only ONE client per folder; read AGENTS.md for more.
# ============================================================

cd "$(dirname "$0")" || exit 1

PY="python3"
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  echo "[run.sh] No .venv yet — creating a venv and installing requirements.txt (first run only)..."
  if python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt; then
    PY=".venv/bin/python"
  else
    echo "[run.sh] Warning: could not build .venv — using the system python3."
  fi
fi

while true; do
  "$PY" muse_client.py
  echo "[run.sh] Client exited — restarting in 5 seconds (Ctrl+C to stop completely)..."
  sleep 5
done
