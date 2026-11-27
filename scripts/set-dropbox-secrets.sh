#!/usr/bin/env bash
# Push DROPBOX_* secrets from .env to Supabase Edge Function secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(tr -d '\r' < .env | grep -E '^[A-Z0-9_]+=' | sed 's/^/export /')"
export SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:?missing SUPABASE_ACCESS_TOKEN in .env}"
REF="${SUPABASE_URL#https://}"; REF="${REF%%.*}"

args=()
for k in DROPBOX_APP_KEY DROPBOX_APP_SECRET DROPBOX_REFRESH_TOKEN DROPBOX_ACCESS_TOKEN; do
  val="${!k:-}"
  if [ -n "$val" ]; then
    args+=("${k}=${val}")
  fi
done

if [ "${#args[@]}" -eq 0 ]; then
  echo "No DROPBOX_* values set in .env yet. Fill DROPBOX_APP_KEY/DROPBOX_APP_SECRET/DROPBOX_REFRESH_TOKEN (or DROPBOX_ACCESS_TOKEN) first."
  exit 1
fi

echo "Setting ${#args[@]} Dropbox secret(s) on project $REF..."
npx --yes supabase secrets set --project-ref "$REF" "${args[@]}"
