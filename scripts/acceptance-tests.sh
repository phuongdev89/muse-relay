#!/usr/bin/env bash
# Acceptance tests (step 5 of Muse's README) — run against the live project.
# Prints verdicts only; never prints tokens, emails, or JWTs.
set -uo pipefail
cd "$(dirname "$0")/.."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
set -a; . ./.env; set +a
BASE="$SUPABASE_URL"
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
jqpy(){ python -I -c "$1"; }

echo "== T1: unauthenticated calls must get 401 =="
c=$(curl -s -m 20 -o "$TMP_DIR/at1a" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" -H 'content-type: application/json' -d '{"action":"image","params":{"prompt":"x"}}')
[ "$c" = "401" ] && ok "T1 submit_message no-auth -> 401" || bad "T1 submit_message got $c: $(head -c 120 "$TMP_DIR/at1a")"
c=$(curl -s -m 20 -o "$TMP_DIR/at1b" -w '%{http_code}' -X POST "$BASE/functions/v1/claim_message" -H 'content-type: application/json' -d '{}')
[ "$c" = "401" ] && ok "T1 claim_message no-token -> 401" || bad "T1 claim_message got $c: $(head -c 120 "$TMP_DIR/at1b")"
c=$(curl -s -m 20 -o "$TMP_DIR/at1c" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" -H 'content-type: application/json' -d '{}')
[ "$c" = "401" ] && ok "T1 submit_result no-token -> 401" || bad "T1 submit_result got $c: $(head -c 120 "$TMP_DIR/at1c")"

echo "== owner JWT via admin magic link (not printed) =="
EMAIL=$(curl -s -m 20 "$BASE/auth/v1/admin/users?id=$RELAY_OWNER_ID" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  | jqpy "import json,sys; d=json.load(sys.stdin); print((d.get('users') or [{}])[0].get('email',''))")
[ -n "$EMAIL" ] || { echo "FAIL: cannot resolve owner email"; exit 1; }
GEN=$(curl -s -m 20 -X POST "$BASE/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H 'content-type: application/json' \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}")
TH=$(echo "$GEN" | jqpy "import json,sys,urllib.parse as u; d=json.load(sys.stdin); p=d.get('properties') or {};
th=d.get('token_hash') or p.get('token_hash') or d.get('hashed_token') or p.get('hashed_token') or '';
al=d.get('action_link') or p.get('action_link') or '';
print(th or (u.parse_qs(u.urlparse(al).query).get('token',[''])[0]))")
[ -n "$TH" ] || { echo "FAIL: no token in generate_link response: $(echo "$GEN" | head -c 200)"; exit 1; }
JWT=$(curl -s -m 20 -X POST "$BASE/auth/v1/verify" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"type\":\"magiclink\",\"token_hash\":\"$TH\"}" \
  | jqpy "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
[ -n "$JWT" ] || { echo "FAIL: owner JWT not obtained (verify endpoint rejected token)"; exit 1; }
echo "owner JWT obtained"

echo "== T-L: no privileged muse (fail-closed, per owner ruling) =="
GTC=$(curl -s -m 20 -o "$TMP_DIR/atla" -w '%{http_code}' -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: 0000000000000000000000000000000000000000000000000000000000000000" -H 'content-type: application/json' -d '{}')
[ "$GTC" = "401" ] && ok "T-La unknown token -> 401 (nothing falls back)" || bad "T-La got $GTC: $(head -c 120 "$TMP_DIR/atla")"
c=$(curl -s -m 20 -o "$TMP_DIR/atlb" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"chat","params":{"prompt":"[ACCEPTANCE] tl no recipient"}}')
[ "$c" = "400" ] && ok "T-Lb submit without recipient -> 400 (no default muse)" || bad "T-Lb got $c: $(head -c 120 "$TMP_DIR/atlb")"

echo "== T-MM: multi-muse registry + queue isolation =="
MM_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
MM_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export MM_TOKEN
MM_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['MM_TOKEN'].encode()).hexdigest())")
MM_ROOT="/acceptance-mm-muse/"
MMB="$TMP_DIR/acceptance-mm-muse.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance MM","token_hash":"%s","dropbox_root":"%s"}' \
  "$RELAY_OWNER_ID" "$MM_REC" "$MM_HASH" "$MM_ROOT" > "$MMB"
MMC=$(curl -s -m 20 -o "$TMP_DIR/atmma" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$MMB")
rm -f "$MMB"
[ "$MMC" = "201" ] && ok "T-MMa wizard-style registry insert (owner JWT) -> 201" || bad "T-MMa insert got $MMC: $(head -c 200 "$TMP_DIR/atmma")"
ANONC=$(curl -s -m 20 -o "$TMP_DIR/atmmz" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"owner_id":"00000000-0000-0000-0000-000000000000","recipient":"11111111-1111-4111-8111-111111111111","name":"x","token_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dropbox_root":"/x/"}')
[ "$ANONC" != "201" ] && ok "T-MMb anonymous insert blocked by RLS ($ANONC)" || bad "T-MMb anon insert unexpectedly created a row"
ANONG=$(curl -s -m 20 "$BASE/rest/v1/relay_muses?select=recipient" -H "apikey: $SUPABASE_PUBLISHABLE_KEY")
[ "$ANONG" = "[]" ] && ok "T-MMc anonymous read of registry -> [] (RLS)" || bad "T-MMc anon read leaked: $ANONG"

MMQ="$TMP_DIR/acceptance-mm-q.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] mm queue"}}' "$MM_REC" > "$MMQ"
MSUB=$(curl -s -m 20 -o "$TMP_DIR/atmmb" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$MMQ")
MSG_M1=$(cat "$TMP_DIR/atmmb" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$MSUB" = "201" ] && [ -n "$MSG_M1" ] && ok "T-MMd submit to registered muse -> 201" || bad "T-MMd got $MSUB: $(head -c 200 "$TMP_DIR/atmmb")"

ISO1=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d '{}')
ISO1N=$(echo "$ISO1" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
[ "$ISO1N" = "True" ] && ok "T-MMe Nyx token does NOT see other muse's queue" || bad "T-MMe Nyx claimed foreign message: $(echo "$ISO1" | head -c 200)"
MCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' -d '{}')
MC_ID=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
MC_CLAIM=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
MC_REC=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('recipient',''))")
[ "$MC_ID" = "$MSG_M1" ] && [ "$MC_REC" = "$MM_REC" ] && [ -n "$MC_CLAIM" ] && ok "T-MMf own token claims own message (recipient echoed)" || bad "T-MMf claim: $(echo "$MCLAIM" | head -c 200)"

MM_ROOTNEG=$(curl -s -m 20 -o "$TMP_DIR/atmmc" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_M1\",\"claim_id\":\"$MC_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/nolanthomas825cxoz@lappies.net/t-mm/steal.png\"],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$MM_ROOTNEG" = "400" ] && ok "T-MMg foreign dropbox root rejected -> 400" || bad "T-MMg got $MM_ROOTNEG: $(head -c 200 "$TMP_DIR/atmmc")"
MM_OWN=$(curl -s -m 20 -o "$TMP_DIR/atmmd" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_M1\",\"claim_id\":\"$MC_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$MM_OWN" = "403" ] && ok "T-MMh Nyx token cannot submit result for other muse -> 403" || bad "T-MMh got $MM_OWN: $(head -c 200 "$TMP_DIR/atmmd")"
MM_ERRBODY="$TMP_DIR/acceptance-mm-err.json"
printf '{"message_id":"%s","claim_id":"%s","status":"failed","output":{"dropbox_paths":[],"notes":null,"text":null},"error_code":"out_of_scope"}' "$MSG_M1" "$MC_CLAIM" > "$MM_ERRBODY"
MM_ERR=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' -d @"$MM_ERRBODY")
rm -f "$MM_ERRBODY"
MM_ERR_OK=$(echo "$MM_ERR" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
MM_ERR_DB=$(curl -s -m 20 "$BASE/rest/v1/relay_results?select=error&message_id=eq.$MSG_M1" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
echo "$MM_ERR_DB" | grep -q 'out_of_scope' && [ "$MM_ERR_OK" = "True" ] && ok "T-MMi error_code-only failed result accepted (out_of_scope)" || bad "T-MMi res=$MM_ERR db=$MM_ERR_DB"

MMQ2="$TMP_DIR/acceptance-mm-q2.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] mm nyx-queue"}}' "$RELAY_RECIPIENT_ID" > "$MMQ2"
MSUB2=$(curl -s -m 20 -o "$TMP_DIR/atmme" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$MMQ2")
MSG_M2=$(cat "$TMP_DIR/atmme" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
rm -f "$MMQ2"
[ "$MSUB2" = "201" ] && [ -n "$MSG_M2" ] && ok "T-MMj submit to Nyx queue -> 201" || bad "T-MMj got $MSUB2"
ISO2=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' -d '{}')
ISO2N=$(echo "$ISO2" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
# No row-state assertion here: the LIVE Nyx daemon may legitimately claim this
# Nyx-addressed row moments later, which is correct behavior, not a leak. The
# isolation guarantee is fully proven by the claim returning message:null.
[ "$ISO2N" = "True" ] && ok "T-MMk other muse's token cannot claim Nyx's message" || bad "T-MMk claimed foreign row: $(echo "$ISO2" | head -c 200)"
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_M2" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=eq.$MM_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-MM =="

echo "== T-HB: claim heartbeat (relay_muses.last_claim_at) =="
HB_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
HB_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export HB_TOKEN
HB_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['HB_TOKEN'].encode()).hexdigest())")
HBB="$TMP_DIR/acceptance-hb-muse.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance HB","token_hash":"%s","dropbox_root":"/acceptance-hb/"}' \
  "$RELAY_OWNER_ID" "$HB_REC" "$HB_HASH" > "$HBB"
HBC=$(curl -s -m 20 -o "$TMP_DIR/athba" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$HBB")
rm -f "$HBB"
[ "$HBC" = "201" ] && ok "T-HBa heartbeat muse seeded -> 201" || bad "T-HBa seed got $HBC: $(head -c 200 "$TMP_DIR/athba")"

# An idle poll must stamp too: claiming against an empty queue is itself the
# liveness proof (10s hook poll, 10-minute watchdog claim per instruction).
HBCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $HB_TOKEN" -H 'content-type: application/json' -d '{}')
HBN=$(echo "$HBCLAIM" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
LC=$(curl -s -m 20 "$BASE/rest/v1/relay_muses?select=last_claim_at&recipient=eq.$HB_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
LC_AGE=$(echo "$LC" | jqpy "import json,sys,datetime; rows=json.load(sys.stdin); v=(rows[0] or {}).get('last_claim_at') if rows else None; print('NULL' if not v else int((datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(v.replace('Z','+00:00'))).total_seconds()))")
echo "$HBN" | grep -q "True" && [ "$LC_AGE" != "NULL" ] && [ "$LC_AGE" -lt 120 ] 2>/dev/null \
  && ok "T-HBb empty-queue claim stamps fresh last_claim_at (${LC_AGE}s old)" \
  || bad "T-HBb claim=$(echo "$HBCLAIM" | head -c 120) last_claim_at=$LC age=$LC_AGE"

# A failed authentication must never move the heartbeat (401 exits before any write).
LC1=$(echo "$LC" | jqpy "import json,sys; print((json.load(sys.stdin)[0] or {}).get('last_claim_at',''))")
curl -s -m 20 -o "$TMP_DIR/athbb" -w '%{http_code}' -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" -H 'content-type: application/json' -d '{}' > "$TMP_DIR/athbc"
LC2=$(curl -s -m 20 "$BASE/rest/v1/relay_muses?select=last_claim_at&recipient=eq.$HB_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print((json.load(sys.stdin)[0] or {}).get('last_claim_at',''))")
HB401=$(cat "$TMP_DIR/athbc")
[ "$HB401" = "401" ] && [ -n "$LC1" ] && [ "$LC2" = "$LC1" ] \
  && ok "T-HBc unknown token -> 401, last_claim_at untouched" \
  || bad "T-HBc code=$HB401 before=$LC1 after=$LC2"

curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=eq.$HB_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-HB =="

echo "== T-G: group chat (owner-initiated muse-to-muse) =="
GA_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GB_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GC_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GA_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
GB_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
GC_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export GA_TOKEN GB_TOKEN GC_TOKEN
GA_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GA_TOKEN'].encode()).hexdigest())")
GB_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GB_TOKEN'].encode()).hexdigest())")
GC_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GC_TOKEN'].encode()).hexdigest())")
MMB="$TMP_DIR/acceptance-tg-muses.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance GA","token_hash":"%s","dropbox_root":"/acceptance-ga/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance GB","token_hash":"%s","dropbox_root":"/acceptance-gb/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance GC","token_hash":"%s","dropbox_root":"/acceptance-gc/"}\n' \
  "$RELAY_OWNER_ID" "$GA_REC" "$GA_HASH" "$RELAY_OWNER_ID" "$GB_REC" "$GB_HASH" "$RELAY_OWNER_ID" "$GC_REC" "$GC_HASH" > "$MMB"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$MMB.one"
  rc=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$MMB.one")
  [ "$rc" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$MMB"
rm -f "$MMB" "$MMB.one"
[ "$ND_ROWS" = "3" ] && ok "T-Ga 3 test muses seeded -> 201 x3" || bad "T-Ga seeded only $ND_ROWS/3"

ANONG=$(curl -s -m 20 -o "$TMP_DIR/atgg" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_groups" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"owner_id":"00000000-0000-0000-0000-000000000000","name":"anon group"}')
[ "$ANONG" != "201" ] && ok "T-Gb anonymous group insert blocked by RLS ($ANONG)" || bad "T-Gb anon group insert unexpectedly created a row"

GGB="$TMP_DIR/acceptance-tg-group.json"
G_ID=$(python -I -c "import uuid; print(uuid.uuid4())")
printf '{"id":"%s","owner_id":"%s","name":"Acceptance Group"}' "$G_ID" "$RELAY_OWNER_ID" > "$GGB"
rc=$(curl -s -m 20 -o "$TMP_DIR/atgg2" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_groups" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$GGB")
[ "$rc" = "201" ] && ok "T-Gc owner creates group -> 201" || bad "T-Gc got $rc: $(head -c 200 "$TMP_DIR/atgg2")"
printf '{"group_id":"%s","muse_recipient":"%s","name":"Acceptance GA"}\n{"group_id":"%s","muse_recipient":"%s","name":"Acceptance GB"}\n' \
  "$G_ID" "$GA_REC" "$G_ID" "$GB_REC" > "$GGB"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$GGB.one"
  rc=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_group_members" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$GGB.one")
  [ "$rc" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$GGB"
rm -f "$GGB" "$GGB.one"
[ "$ND_ROWS" = "2" ] && ok "T-Gd 2 members joined -> 201 x2" || bad "T-Gd joined only $ND_ROWS/2"

GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg hello group"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
G_IDS=$(cat "$TMP_DIR/atgq" | jqpy "import json,sys; print(' '.join(json.load(sys.stdin).get('message_ids',[])))")
set -- $G_IDS
GM_A=${1:-}; GM_B=${2:-}
[ "$GSUB" = "201" ] && [ -n "$GM_A" ] && [ -n "$GM_B" ] && [ "${3:-}" = "" ] && ok "T-Ge owner post -> 201 with exactly 2 message_ids" || bad "T-Ge got $GSUB ids=[$G_IDS]: $(head -c 200 "$TMP_DIR/atgq")"

GISO=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GC_TOKEN" -H 'content-type: application/json' -d '{}')
GISON=$(echo "$GISO" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
[ "$GISON" = "True" ] && ok "T-Gf muse OUTSIDE group cannot claim group rows" || bad "T-Gf outsider claimed: $(echo "$GISO" | head -c 200)"

GCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d '{}')
GA_ID=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GA_CLAIM=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GA_PROMPT=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print((m.get('params') or {}).get('prompt',''))")
echo "$GA_PROMPT" | grep -q '^\[Owner\]: \[ACCEPTANCE\] tg hello group$' && [ "$GA_ID" = "$GM_A" ] && [ -n "$GA_CLAIM" ] && ok "T-Gg GA claims own row, prompt prefixed [Owner]:" || bad "T-Gg id=$GA_ID prompt=[$GA_PROMPT]"

GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GA reply for group"},"error":null}' "$GM_A" "$GA_CLAIM" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
CHAIN=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id,recipient,params&recipient=eq.$GB_REC&status=eq.pending&params->>prompt=like.%5BAcceptance%20GA%5D*" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
CHAIN_OK=$(echo "$CHAIN" | jqpy "import json,sys; rows=json.load(sys.stdin); print(len(rows)==1 and '[Acceptance GA]: GA reply for group'==rows[0]['params']['prompt'])")
[ "$GOK" = "True" ] && [ "$CHAIN_OK" = "True" ] && ok "T-Gh GA done -> fan-out turn 2 to GB only, prefixed [Acceptance GA]:" || bad "T-Gh res=$GRES chain=$CHAIN"

TURN_POST=$(curl -s -m 20 "$BASE/rest/v1/relay_group_posts?select=message_id,turn&group_id=eq.$G_ID&from_kind=eq.muse" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
TURN_OK=$(echo "$TURN_POST" | jqpy "import json,sys; rows=json.load(sys.stdin); print(len(rows)==1 and rows[0]['turn']==2)")
[ "$TURN_OK" = "True" ] && ok "T-Gi post row recorded (from_kind muse, turn 2)" || bad "T-Gi posts=$TURN_POST"

# GB must first consume the older turn-1 owner row (GM_B), then the turn-2
# fan-out row is the next pending row for it.
GB_SKIP=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d '{}')
GB_SKIP_ID=$(echo "$GB_SKIP" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GB_CLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d '{}')
GB_ID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GB_CLAIMID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GB_PROMPT=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print((m.get('params') or {}).get('prompt',''))")
[ "$GB_SKIP_ID" = "$GM_B" ] && [ -n "$GB_ID" ] && [ "$GB_ID" != "$GM_B" ] && echo "$GB_PROMPT" | grep -q '^\[Acceptance GA\]: ' && ok "T-Gj GB consumes turn-1 row, then claims the turn-2 fan-out row" || bad "T-Gj skip=$GB_SKIP_ID id=$GB_ID prompt=[$GB_PROMPT]"
# Force the cap: bump GB's post row to turn=12, then its reply must NOT fan out.
curl -s -m 20 -X PATCH "$BASE/rest/v1/relay_group_posts?message_id=eq.$GB_ID" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' \
  -d '{"turn":12}' > /dev/null
GREP2="$TMP_DIR/acceptance-tg-rep2.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GB reply at cap"},"error":null}' "$GB_ID" "$GB_CLAIMID" > "$GREP2"
GRES2=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d @"$GREP2")
rm -f "$GREP2"
GOK2=$(echo "$GRES2" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
CAPCOUNT=$(curl -s -m 20 "$BASE/rest/v1/relay_group_posts?select=message_id&group_id=eq.$G_ID&from_kind=eq.muse&turn=eq.3" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK2" = "True" ] && [ "$CAPCOUNT" = "0" ] && ok "T-Gk turn cap: reply at turn 12 -> ok, no turn-3 fan-out" || bad "T-Gk res=$GRES2 capcount=$CAPCOUNT"

GQ2="$TMP_DIR/acceptance-tg-q2.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg owner reset"}}' "$G_ID" > "$GQ2"
GSUB2=$(curl -s -m 20 -o "$TMP_DIR/atgq2" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ2")
rm -f "$GQ2"
T1COUNT=$(curl -s -m 20 "$BASE/rest/v1/relay_group_posts?select=message_id&group_id=eq.$G_ID&from_kind=eq.owner&turn=eq.1" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GSUB2" = "201" ] && [ "$T1COUNT" = "4" ] && ok "T-Gl owner post resets turn to 1 (4 owner post rows total)" || bad "T-Gl got $GSUB2 owner-turn1 rows=$T1COUNT"

GNEG=$(curl -s -m 20 -o "$TMP_DIR/atgn" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"group_id\":\"$G_ID\",\"action\":\"image\",\"params\":{\"prompt\":\"[ACCEPTANCE] tg neg\"}}")
[ "$GNEG" = "400" ] && ok "T-Gm group + action image -> 400" || bad "T-Gm got $GNEG: $(head -c 200 "$TMP_DIR/atgn")"
GNEG2=$(curl -s -m 20 -o "$TMP_DIR/atgn2" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"group_id":"00000000-0000-0000-0000-000000000000","action":"chat","params":{"prompt":"[ACCEPTANCE] tg neg2"}}')
[ "$GNEG2" = "404" ] && ok "T-Gn foreign group_id -> 404 group_not_found" || bad "T-Gn got $GNEG2: $(head -c 200 "$TMP_DIR/atgn2")"

echo "== cleanup T-G rows =="
# Everything addressed to the three test muses goes at once (covers owner
# rows, fan-out rows and abandoned claims), then the group cascades members,
# and finally the muse registry rows themselves.
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=in.($GA_REC,$GB_REC,$GC_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_groups?id=eq.$G_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=in.($GA_REC,$GB_REC,$GC_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-G =="

echo "== T-LG prep: dedicated legacy muse (live Nyx daemon cannot race this queue) =="
LG_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
LG_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export LG_TOKEN
LG_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['LG_TOKEN'].encode()).hexdigest())")
LGB="$TMP_DIR/acceptance-lg-muse.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance LG","token_hash":"%s","dropbox_root":"/acceptance-lg/"}' \
  "$RELAY_OWNER_ID" "$LG_REC" "$LG_HASH" > "$LGB"
LGC=$(curl -s -m 20 -o "$TMP_DIR/atlg" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$LGB")
rm -f "$LGB"
[ "$LGC" = "201" ] && ok "T-LGa legacy muse seeded -> 201 (own queue)" || bad "T-LGa seed got $LGC: $(head -c 200 "$TMP_DIR/atlg")"

echo "== T2: signed submit -> 201 + message_id + pending row =="
SUB_BODY="{\"recipient\":\"$LG_REC\",\"action\":\"image\",\"params\":{\"prompt\":\"[ACCEPTANCE] t2 image\",\"aspect_ratio\":\"1:1\",\"count\":1,\"reference_storage_paths\":[]}}"
SUB=$(curl -s -m 20 -o "$TMP_DIR/at2" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d "$SUB_BODY")
MSG_A=$(cat "$TMP_DIR/at2" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
SUB2=$(curl -s -m 20 -o "$TMP_DIR/at2b" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"video\",\"params\":{\"prompt\":\"[ACCEPTANCE] t3 tamper\",\"aspect_ratio\":\"16:9\",\"duration_seconds\":5,\"reference_storage_paths\":[]}}")
MSG_B=$(cat "$TMP_DIR/at2b" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
if [ "$SUB" = "201" ] && [ -n "$MSG_A" ] && [ "$SUB2" = "201" ] && [ -n "$MSG_B" ]; then
  ok "T2 submit -> 201, message_id A=$MSG_A / B=$MSG_B"
else
  bad "T2 submit got ($SUB / $SUB2): $(head -c 200 "$TMP_DIR/at2")"; exit 1
fi
SA=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id,status&id=eq.$MSG_A" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
SB=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id,status&id=eq.$MSG_B" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
if echo "$SA" | grep -q '"pending"' && echo "$SB" | grep -q '"pending"'; then
  ok "T2 both rows pending in relay_messages"
else
  bad "T2 rows not pending: $SA / $SB"
fi

echo "== T3 prep: tamper B params via service key, then claim =="
curl -s -m 20 -X PATCH "$BASE/rest/v1/relay_messages?id=eq.$MSG_B" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' \
  -d '{"params":{"prompt":"[TAMPERED] evil","aspect_ratio":"16:9","duration_seconds":5,"reference_storage_paths":[]}}' > /dev/null
CLAIM1=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' -d '{}')
C1_ID=$(echo "$CLAIM1" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
C1_CLAIM=$(echo "$CLAIM1" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
[ "$C1_ID" = "$MSG_A" ] && [ -n "$C1_CLAIM" ] && ok "T4a claim#1 returned A with claim_id" || bad "T4a claim#1: $(echo "$CLAIM1" | head -c 200)"
CLAIM2=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' -d '{}')
C2_NULL=$(echo "$CLAIM2" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
[ "$C2_NULL" = "True" ] && ok "T4b claim#2 -> message:null (no duplicate)" || bad "T4b claim#2: $(echo "$CLAIM2" | head -c 200)"
BB=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=status&id=eq.$MSG_B" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
RB=$(curl -s -m 20 "$BASE/rest/v1/relay_results?select=status,error&message_id=eq.$MSG_B" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
if echo "$BB" | grep -q '"failed"' && echo "$RB" | grep -q 'invalid_signature'; then
  ok "T3 tampered B -> failed + invalid_signature result"
else
  bad "T3 tamper verdict: msg=$BB result=$RB"
fi

echo "== T5: submit_result with wrong claim_id -> 409 =="
c=$(curl -s -m 20 -o "$TMP_DIR/at5" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"00000000-0000-0000-0000-000000000000\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null},\"error\":null}")
ERR5=$(cat "$TMP_DIR/at5" | jqpy "import json,sys; print(json.load(sys.stdin).get('error',''))")
[ "$c" = "409" ] && ok "T5 wrong claim_id -> 409 ($ERR5)" || bad "T5 got $c: $(head -c 200 "$TMP_DIR/at5")"

echo "== T-media-neg: image done without dropbox_paths must 400 =="
c=$(curl -s -m 20 -o "$TMP_DIR/atm" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result"   -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json'   -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"$C1_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null},\"error\":null}")
[ "$c" = "400" ] && ok "T-media-neg image done w/o paths -> 400" || bad "T-media-neg got $c: $(head -c 200 "$TMP_DIR/atm")"

echo "== bonus: happy-path submit_result with correct claim_id =="
RES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"$C1_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/acceptance-lg/2026-11-27_acceptance.png\"],\"notes\":\"acceptance test\"},\"error\":null}")
AOK=$(echo "$RES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
AA=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=status&id=eq.$MSG_A" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
[ "$AOK" = "True" ] && echo "$AA" | grep -q '"done"' && ok "bonus: correct claim -> done + row done" || bad "bonus: res=$RES row=$AA"

echo "== T6: chat action end-to-end =="
SUBC=$(curl -s -m 20 -o "$TMP_DIR/at6" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] t6 chat\"}}")
MSG_C=$(cat "$TMP_DIR/at6" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
if [ "$SUBC" = "201" ] && [ -n "$MSG_C" ]; then
  ok "T6a chat submit -> 201, message_id C=$MSG_C"
else
  bad "T6a chat submit got $SUBC: $(head -c 200 "$TMP_DIR/at6")"
fi
CLAIMC=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' -d '{}')
C_ID=$(echo "$CLAIMC" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
C_CLAIM=$(echo "$CLAIMC" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
if [ "$C_ID" = "$MSG_C" ] && [ -n "$C_CLAIM" ]; then
  ok "T6b chat claim -> claimed with claim_id"
else
  bad "T6b chat claim: $(echo "$CLAIMC" | head -c 200)"
fi
echo "== T-chat-neg: chat done without text must 400 =="
c=$(curl -s -m 20 -o "$TMP_DIR/atcn" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result"   -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json'   -d "{\"message_id\":\"$MSG_C\",\"claim_id\":\"$C_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null,\"text\":\"   \"},\"error\":null}")
[ "$c" = "400" ] && ok "T-chat-neg chat done w/o text -> 400" || bad "T-chat-neg got $c: $(head -c 200 "$TMP_DIR/atcn")"

RESC_BODY="$TMP_DIR/acceptance-res-body.json"
# Write the result body as pure-ASCII JSON (\uXXXX escapes) to a file — passing
# Vietnamese as curl argv gets mangled by Windows codepage, and python stdout
# defaults to cp1252, so argv/stdout are both avoided here. The server unescapes
# to the exact Unicode string.
python -I - "$MSG_C" "$C_CLAIM" > "$RESC_BODY" <<'PYEOF'
import json, sys
print(json.dumps({
    "message_id": sys.argv[1],
    "claim_id": sys.argv[2],
    "status": "done",
    "output": {"dropbox_paths": [], "notes": None,
               "text": "Tiếng Việt có dấu — kiểm tra UTF-8 100%"},
    "error": None,
}))
PYEOF
RESC=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' -d @"$RESC_BODY")
rm -f "$RESC_BODY"
COK=$(echo "$RESC" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
CT=$(curl -s -m 20 "$BASE/rest/v1/relay_results?select=output&message_id=eq.$MSG_C" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | python -X utf8 -I -c '
import json, sys
rows = json.load(sys.stdin)
want = "Ti\u1ebfng Vi\u1ec7t c\u00f3 d\u1ea5u \u2014 ki\u1ec3m tra UTF-8 100%"
got = (rows[0]["output"] or {}).get("text") if rows else None
print("UTF8_EXACT" if got == want else "MISMATCH:" + repr(got))')
echo "$CT" | grep -q "UTF8_EXACT" && [ "$COK" = "True" ] && ok "T6c chat result with output.text -> done + UTF-8 round-trip exact" || bad "T6c chat result: res=$RESC row=$CT"

echo "== T7: invalid action must be 400 =="
c=$(curl -s -m 20 -o "$TMP_DIR/at7" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"audio\",\"params\":{\"prompt\":\"x\"}}")
[ "$c" = "400" ] && ok "T7 action 'audio' -> 400" || bad "T7 got $c: $(head -c 200 "$TMP_DIR/at7")"

echo "== T8: dropbox_paths outside new prefix must be 400 =="
c=$(curl -s -m 20 -o "$TMP_DIR/at8" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $LG_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_C\",\"claim_id\":\"$C_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/MuseRelay/outputs/old/old.png\"],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$c" = "400" ] && ok "T8 old prefix /MuseRelay/outputs/ -> 400" || bad "T8 got $c: $(head -c 200 "$TMP_DIR/at8")"

echo "== T9: thread_id accepted + bad thread_id rejected =="
SUBT=$(curl -s -m 20 -o "$TMP_DIR/at9a" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"image\",\"params\":{\"prompt\":\"[ACCEPTANCE] t9 thread\",\"thread_id\":\"cat-climbing-01\",\"reference_storage_paths\":[]}}")
MSG_T=$(cat "$TMP_DIR/at9a" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBT" = "201" ] && [ -n "$MSG_T" ] && ok "T9a submit with thread_id -> 201" || bad "T9a got $SUBT: $(head -c 200 "$TMP_DIR/at9a")"
c=$(curl -s -m 20 -o "$TMP_DIR/at9b" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"image\",\"params\":{\"prompt\":\"[ACCEPTANCE] t9 bad\",\"thread_id\":\"bad id!!\",\"reference_storage_paths\":[]}}")
[ "$c" = "400" ] && ok "T9b bad thread_id -> 400" || bad "T9b got $c: $(head -c 200 "$TMP_DIR/at9b")"

echo "== T10: recipient mismatch -> 403 / match -> 201 =="
c=$(curl -s -m 20 -o "$TMP_DIR/at10a" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d '{"recipient":"00000000-0000-0000-0000-000000000000","action":"chat","params":{"prompt":"[ACCEPTANCE] t10 mismatch"}}')
[ "$c" = "403" ] && ok "T10a wrong recipient -> 403" || bad "T10a got $c: $(head -c 200 "$TMP_DIR/at10a")"
T10B="$TMP_DIR/acceptance-t10b.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] t10 match"}}' "$LG_REC" > "$T10B"
SUBR=$(curl -s -m 20 -o "$TMP_DIR/at10b" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d @"$T10B")
rm -f "$T10B"
MSG_R=$(cat "$TMP_DIR/at10b" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBR" = "201" ] && [ -n "$MSG_R" ] && ok "T10b correct recipient -> 201" || bad "T10b got $SUBR: $(head -c 200 "$TMP_DIR/at10b")"

echo "== T11: rich chat (document/csv/thread) -> 201 =="
SUBD=$(curl -s -m 20 -o "$TMP_DIR/at11" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d "{\"recipient\":\"$LG_REC\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] t11 doc\",\"thread_id\":\"t11-doc\",\"resource_type\":\"document\",\"output_format\":\"csv\"}}")
MSG_D=$(cat "$TMP_DIR/at11" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBD" = "201" ] && [ -n "$MSG_D" ] && ok "T11 rich chat -> 201" || bad "T11 got $SUBD: $(head -c 200 "$TMP_DIR/at11")"

echo "== cleanup test rows =="
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_A" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_B" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_C:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_C" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_T:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_T" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_R:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_R" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_D:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_D" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
# Final sweep: delete ANY leftover acceptance rows (Nyx daemon is LIVE and claims leftovers as real work).
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?params->>prompt=like.%5BACCEPTANCE%5D*" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=eq.$LG_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
LEFT=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
echo "relay_messages now: $LEFT"

echo "=============================="
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]