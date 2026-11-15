#!/usr/bin/env bash
# ============================================================
#  Muse Relay — chạy client trên máy Muse (Linux/macOS)
#
#  Cách dùng:
#      bash run.sh
#
#  Script làm gì:
#    1. cd vào đúng thư mục chứa script (nơi có muse_client.py, .env).
#    2. Nếu chưa có .venv: tạo venv và cài requirements.txt (lần đầu).
#    3. Chạy muse_client.py trong vòng lặp restart: client thoát hoặc
#       chết thì chờ 5 giây rồi tự chạy lại.
#
#  Dừng hẳn: nhấn Ctrl+C (client thoát sạch sẽ).
#  Lưu ý: chỉ chạy MỘT client cho một thư mục; đọc thêm AGENTS.md.
# ============================================================

cd "$(dirname "$0")" || exit 1

PY="python3"
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  echo "[run.sh] Chưa có .venv — tạo venv và cài requirements.txt (chỉ lần đầu)..."
  if python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt; then
    PY=".venv/bin/python"
  else
    echo "[run.sh] Cảnh báo: chưa dựng được .venv — dùng python3 hệ thống."
  fi
fi

while true; do
  "$PY" muse_client.py
  echo "[run.sh] Client đã thoát — tự khởi động lại sau 5 giây (Ctrl+C để dừng hẳn)..."
  sleep 5
done
