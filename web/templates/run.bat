@echo off
chcp 65001 >nul
rem ============================================================
rem  Muse Relay — chạy client trên máy Muse (Windows)
rem
rem  Cách dùng: nhấp đúp vào tệp này, hoặc mở CMD rồi gõ: run.bat
rem
rem  Script làm gì:
rem    1. cd vào đúng thư mục chứa script (nơi có muse_client.py, .env).
rem    2. Nếu chưa có .venv: tạo venv và cài requirements.txt (lần đầu).
rem    3. Chạy muse_client.py trong vòng lặp restart: client thoát hoặc
rem       chết thì chờ 5 giây rồi tự chạy lại.
rem
rem  Dừng hẳn: đóng cửa sổ CMD hoặc nhấn Ctrl+C.
rem  Lưu ý: chỉ chạy MỘT client cho một thư mục; đọc thêm AGENTS.md.
rem  Yêu cầu: đã cài Python và có lệnh python trong PATH.
rem ============================================================

cd /d "%~dp0"

set "PY=python"
if not exist ".venv\Scripts\python.exe" (
  echo [run.bat] Chưa có .venv — tạo venv và cài requirements.txt ^(chỉ lần đầu^)...
  python -m venv .venv && ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

:loop
"%PY%" muse_client.py
echo [run.bat] Client đã thoát — tự khởi động lại sau 5 giây ^(đóng cửa sổ để dừng hẳn^)...
timeout /t 5 /nobreak >nul
goto loop
