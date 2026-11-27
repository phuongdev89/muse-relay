@echo off
chcp 65001 >nul
rem ============================================================
rem  Muse Relay — run the client on the Muse machine (Windows)
rem
rem  Usage: double-click this file, or open CMD and type: run.bat
rem
rem  What the script does:
rem    1. cd into the folder containing this script (where muse_client.py
rem       and config.json live). First run mints a session from
rem       MUSE_PASSWORD in config.json, saves it to state/session.json,
rem       and scrubs the password from config.json.
rem    2. If there is no .venv yet: create a venv and install
rem       requirements.txt (first run only).
rem    3. Run muse_client.py in a restart loop: if the client exits or
rem       dies, wait 5 seconds and run it again.
rem
rem  To stop completely: close the CMD window or press Ctrl+C.
rem  Note: run only ONE client per folder; read AGENTS.md for more.
rem  Requirement: Python installed and the python command in PATH.
rem ============================================================

cd /d "%~dp0"

set "PY=python"
if not exist ".venv\Scripts\python.exe" (
  echo [run.bat] No .venv yet — creating a venv and installing requirements.txt ^(first run only^)...
  python -m venv .venv && ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

:loop
"%PY%" muse_client.py
echo [run.bat] Client exited — restarting in 5 seconds ^(close the window to stop completely^)...
timeout /t 5 /nobreak >nul
goto loop
