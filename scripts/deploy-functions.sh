#!/usr/bin/env bash
# Deploy the 3 relay Edge Functions to Supabase.
# Requires SUPABASE_ACCESS_TOKEN in .env (dashboard -> Account -> Access Tokens).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:?missing SUPABASE_ACCESS_TOKEN in .env}"
REF="${SUPABASE_URL#https://}"; REF="${REF%%.*}"
echo "Project ref: $REF"
npx --yes supabase functions deploy submit_message  --project-ref "$REF" --yes
npx --yes supabase functions deploy claim_message  --project-ref "$REF" --yes
npx --yes supabase functions deploy submit_result --project-ref "$REF" --yes
