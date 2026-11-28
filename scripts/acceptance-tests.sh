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

echo "== T-G: group chat (v8 mention routing) =="
GA_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GB_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GC_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GD_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
GA_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
GB_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
GC_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
GD_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export GA_TOKEN GB_TOKEN GC_TOKEN GD_TOKEN
GA_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GA_TOKEN'].encode()).hexdigest())")
GB_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GB_TOKEN'].encode()).hexdigest())")
GC_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GC_TOKEN'].encode()).hexdigest())")
GD_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['GD_TOKEN'].encode()).hexdigest())")
MMB="$TMP_DIR/acceptance-tg-muses.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance GA","token_hash":"%s","dropbox_root":"/acceptance-ga/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance GB","token_hash":"%s","dropbox_root":"/acceptance-gb/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance GC","token_hash":"%s","dropbox_root":"/acceptance-gc/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance GD","token_hash":"%s","dropbox_root":"/acceptance-gd/"}\n' \
  "$RELAY_OWNER_ID" "$GA_REC" "$GA_HASH" "$RELAY_OWNER_ID" "$GB_REC" "$GB_HASH" "$RELAY_OWNER_ID" "$GC_REC" "$GC_HASH" "$RELAY_OWNER_ID" "$GD_REC" "$GD_HASH" > "$MMB"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$MMB.one"
  rc=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$MMB.one")
  [ "$rc" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$MMB"
rm -f "$MMB" "$MMB.one"
[ "$ND_ROWS" = "4" ] && ok "T-Ga 4 test muses seeded -> 201 x4" || bad "T-Ga seeded only $ND_ROWS/4"

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
printf '{"group_id":"%s","muse_recipient":"%s","name":"Acceptance GA"}\n{"group_id":"%s","muse_recipient":"%s","name":"Acceptance GB"}\n{"group_id":"%s","muse_recipient":"%s","name":"Acceptance GC"}\n' \
  "$G_ID" "$GA_REC" "$G_ID" "$GB_REC" "$G_ID" "$GC_REC" > "$GGB"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$GGB.one"
  rc=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_group_members" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$GGB.one")
  [ "$rc" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$GGB"
rm -f "$GGB" "$GGB.one"
[ "$ND_ROWS" = "3" ] && ok "T-Gd 3 members joined -> 201 x3" || bad "T-Gd joined only $ND_ROWS/3"

# Owner post WITHOUT any mention: still recorded in the timeline (one done row
# addressed to the owner itself) but NO muse is woken.
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg hello group"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
G_IDS=$(cat "$TMP_DIR/atgq" | jqpy "import json,sys; print(' '.join(json.load(sys.stdin).get('message_ids',[])))")
set -- $G_IDS
GM_O=${1:-}
GE_OK="False"
if [ -n "$GM_O" ]; then
  GEROW=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=status,recipient,params&id=eq.$GM_O" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
  GE_OK=$(echo "$GEROW" | jqpy "import json,sys; rows=json.load(sys.stdin); p=(rows[0]['params'] if rows else {}); print(len(rows)==1 and rows[0]['status']=='done' and rows[0]['recipient']=='$RELAY_OWNER_ID' and p.get('thread_id')=='$G_ID' and p.get('prompt','').startswith('[Owner]: '))")
fi
[ "$GSUB" = "201" ] && [ "$GE_OK" = "True" ] && ok "T-Ge owner post no mention -> 1 record-only done row (owner recipient, thread_id stamped)" || bad "T-Ge got $GSUB ids=[$G_IDS] row=$GEROW"

GISO=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GD_TOKEN" -H 'content-type: application/json' -d '{}')
GISON=$(echo "$GISO" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
[ "$GISON" = "True" ] && ok "T-Gf muse OUTSIDE group cannot claim group rows" || bad "T-Gf outsider claimed: $(echo "$GISO" | head -c 200)"

# Owner post WITH @Acceptance GA: exactly one delivery row, mention inline.
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @Acceptance GA start"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
G_IDS=$(cat "$TMP_DIR/atgq" | jqpy "import json,sys; print(' '.join(json.load(sys.stdin).get('message_ids',[])))")
set -- $G_IDS
GM_A=${1:-}
GCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d '{}')
GA_ID=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GA_CLAIM=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GA_PARAMS=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); import json as j; print(j.dumps(m.get('params') or {}))")
GA_PROMPT=$(echo "$GA_PARAMS" | jqpy "import json,sys; print(json.load(sys.stdin).get('prompt',''))")
GA_THREAD=$(echo "$GA_PARAMS" | jqpy "import json,sys; print(json.load(sys.stdin).get('thread_id',''))")
[ "$GSUB" = "201" ] && [ -n "$GM_A" ] && [ "${2:-}" = "" ] && [ "$GA_ID" = "$GM_A" ] && echo "$GA_PROMPT" | grep -q '^\[Owner\]: \[ACCEPTANCE\] tg @Acceptance GA start$' && [ "$GA_THREAD" = "$G_ID" ] \
  && ok "T-Gg owner @Name post -> single GA row, [Owner] prefix, thread_id=group" || bad "T-Gg got $GSUB ids=[$G_IDS] id=$GA_ID prompt=[$GA_PROMPT] thread=[$GA_THREAD]"

# THE LOOP FIX: a reply with NO mention fans out to NOBODY.
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GA reply no mention"},"error":null}' "$GA_ID" "$GA_CLAIM" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
MP_N=$(curl -s -m 20 "$BASE/rest/v1/relay_group_posts?select=message_id&group_id=eq.$G_ID&from_kind=eq.muse" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GB_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GB_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GC_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GC_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$MP_N" = "0" ] && [ "$GB_N" = "0" ] && [ "$GC_N" = "0" ] && ok "T-Gh GA reply without mention -> NO fan-out (greeting loop killed)" || bad "T-Gh res=$GRES posts=$MP_N gb=$GB_N gc=$GC_N"

# A reply that MENTIONS @Acceptance GB reaches exactly GB (thread_id stamped).
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @Acceptance GA route"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
GCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d '{}')
GA_ID=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GA_CLAIM=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GA passes to @Acceptance GB"},"error":null}' "$GA_ID" "$GA_CLAIM" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
GBROW=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id,recipient,status,params&recipient=eq.$GB_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
GB_OK=$(echo "$GBROW" | jqpy "import json,sys; rows=json.load(sys.stdin); p=(rows[0]['params'] if rows else {}); print(len(rows)==1 and rows[0]['recipient']=='$GB_REC' and p.get('prompt')=='[Acceptance GA]: GA passes to @Acceptance GB' and p.get('thread_id')=='$G_ID')")
TURN_POST=$(curl -s -m 20 "$BASE/rest/v1/relay_group_posts?select=message_id,turn&group_id=eq.$G_ID&from_kind=eq.muse" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
TURN_OK=$(echo "$TURN_POST" | jqpy "import json,sys; rows=json.load(sys.stdin); print(len(rows)==1 and rows[0]['turn']==2)")
[ "$GOK" = "True" ] && [ "$GB_OK" = "True" ] && [ "$TURN_OK" = "True" ] && ok "T-Gi GA reply @GB -> exactly 1 GB row (turn 2, thread_id stamped)" || bad "T-Gi res=$GRES rows=$GBROW posts=$TURN_POST"

GB_CLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d '{}')
GB_ID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GB_CLAIMID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GB hands to @Acceptance GC"},"error":null}' "$GB_ID" "$GB_CLAIMID" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
GCROW=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GC_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
GC_N=$(echo "$GCROW" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$GC_N" = "1" ] && ok "T-Gj GB reply @GC -> exactly 1 GC row (turn 3)" || bad "T-Gj res=$GRES gcrows=$GCROW"

# Force the cap: bump GC's post row to turn=12, then a reply WITH a mention
# must still NOT fan out.
GC_CLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GC_TOKEN" -H 'content-type: application/json' -d '{}')
GC_ID=$(echo "$GC_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GC_CLAIMID=$(echo "$GC_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
curl -s -m 20 -X PATCH "$BASE/rest/v1/relay_group_posts?message_id=eq.$GC_ID" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' \
  -d '{"turn":12}' > /dev/null
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GC reply at cap @Acceptance GA"},"error":null}' "$GC_ID" "$GC_CLAIMID" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GC_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
GAPEND=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GA_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
GAP_N=$(echo "$GAPEND" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$GAP_N" = "0" ] && ok "T-Gk turn cap: mention reply at turn 12 -> ok, no fan-out" || bad "T-Gk res=$GRES gapend=$GAPEND"

# v9 owner ruling: @all is OWNER-ONLY. GA's reply containing @all must wake
# NOBODY (silently ignored like an unknown mention) and the chain stops.
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @Acceptance GA all"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
GCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d '{}')
GA_ID=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GA_CLAIM=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GA calls @all now"},"error":null}' "$GA_ID" "$GA_CLAIM" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
GB_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GB_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GC_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GC_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GAP_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GA_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$GB_N" = "0" ] && [ "$GC_N" = "0" ] && [ "$GAP_N" = "0" ] && ok "T-GNa muse reply @all -> NO fan-out (owner-only command)" || bad "T-GNa res=$GRES gb=$GB_N gc=$GC_N ga=$GAP_N"

# A muse steers the chain with at most ONE named agent: a reply tagging
# several agents fans out to NOBODY (task decomposition happens across turns,
# never via mass pinging in one output).
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @Acceptance GA multi"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
GCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d '{}')
GA_ID=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GA_CLAIM=$(echo "$GCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GA tags @Acceptance GB and @Acceptance GC together"},"error":null}' "$GA_ID" "$GA_CLAIM" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GA_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
GB_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GB_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GC_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GC_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$GB_N" = "0" ] && [ "$GC_N" = "0" ] && ok "T-GNc muse reply tagging 2 agents -> NO fan-out (single-mention rule)" || bad "T-GNc res=$GRES gb=$GB_N gc=$GC_N"

# Unknown mention: silently ignored, nothing fans out. The owner @GB post
# gives GB a row to claim (muse @all no longer fans one out).
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @Acceptance GB probe"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
GB_CLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d '{}')
GB_ID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
GB_CLAIMID=$(echo "$GB_CLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
GREP="$TMP_DIR/acceptance-tg-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"GB unknown @Nobody here"},"error":null}' "$GB_ID" "$GB_CLAIMID" > "$GREP"
GRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $GB_TOKEN" -H 'content-type: application/json' -d @"$GREP")
rm -f "$GREP"
GOK=$(echo "$GRES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
UNKNOWN=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&params->>prompt=like.%5BAcceptance%20GB%5D%3A%20GB%20unknown*" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
UNKNOWN_N=$(echo "$UNKNOWN" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GOK" = "True" ] && [ "$UNKNOWN_N" = "0" ] && ok "T-GNb unknown mention @Nobody -> ignored, no fan-out" || bad "T-GNb res=$GRES unknown=$UNKNOWN"

# Owner @all post: one delivery row per member (3).
GQ="$TMP_DIR/acceptance-tg-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] tg @all assemble"}}' "$G_ID" > "$GQ"
GSUB=$(curl -s -m 20 -o "$TMP_DIR/atgq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$GQ")
rm -f "$GQ"
G_IDS=$(cat "$TMP_DIR/atgq" | jqpy "import json,sys; print(' '.join(json.load(sys.stdin).get('message_ids',[])))")
G_IDS_N=$(echo "$G_IDS" | wc -w | tr -d ' ')
GA_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GA_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
GB_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$GB_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$GSUB" = "201" ] && [ "$G_IDS_N" = "3" ] && [ "$GA_N" = "1" ] && [ "$GB_N" = "1" ] && ok "T-Gl owner @all post -> 3 delivery rows (GA/GB/GC)" || bad "T-Gl got $GSUB ids_n=$G_IDS_N ga=$GA_N gb=$GB_N"

GNEG=$(curl -s -m 20 -o "$TMP_DIR/atgn" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"group_id\":\"$G_ID\",\"action\":\"image\",\"params\":{\"prompt\":\"[ACCEPTANCE] tg neg\"}}")
[ "$GNEG" = "400" ] && ok "T-Gm group + action image -> 400" || bad "T-Gm got $GNEG: $(head -c 200 "$TMP_DIR/atgn")"
GNEG2=$(curl -s -m 20 -o "$TMP_DIR/atgn2" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"group_id":"00000000-0000-0000-0000-000000000000","action":"chat","params":{"prompt":"[ACCEPTANCE] tg neg2"}}')
[ "$GNEG2" = "404" ] && ok "T-Gn foreign group_id -> 404 group_not_found" || bad "T-Gn got $GNEG2: $(head -c 200 "$TMP_DIR/atgn2")"

echo "== cleanup T-G rows =="
# Everything addressed to the test muses goes at once (covers owner rows,
# fan-out rows and abandoned claims), the record-only owner rows of THIS
# acceptance group go by thread_id, then the group cascades members, and
# finally the muse registry rows themselves.
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=in.($GA_REC,$GB_REC,$GC_REC,$GD_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=eq.$RELAY_OWNER_ID&params->>thread_id=eq.$G_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_groups?id=eq.$G_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=in.($GA_REC,$GB_REC,$GC_REC,$GD_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-G =="

echo "== T-SP/T-BF: v9 group rules + unread backfill =="
SP_A_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
SP_B_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
SP_A_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
SP_B_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export SP_A_TOKEN SP_B_TOKEN
SP_A_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['SP_A_TOKEN'].encode()).hexdigest())")
SP_B_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['SP_B_TOKEN'].encode()).hexdigest())")
SPM="$TMP_DIR/acceptance-sp-muses.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance SA","token_hash":"%s","dropbox_root":"/acceptance-sa/"}\n{"owner_id":"%s","recipient":"%s","name":"Acceptance SB","token_hash":"%s","dropbox_root":"/acceptance-sb/"}\n' \
  "$RELAY_OWNER_ID" "$SP_A_REC" "$SP_A_HASH" "$RELAY_OWNER_ID" "$SP_B_REC" "$SP_B_HASH" > "$SPM"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$SPM.one"
  rc=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$SPM.one")
  [ "$rc" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$SPM"
rm -f "$SPM" "$SPM.one"
[ "$ND_ROWS" = "2" ] && ok "T-SP0 2 rules-test muses seeded -> 201 x2" || bad "T-SP0 seeded only $ND_ROWS/2"

SPG="$TMP_DIR/acceptance-sp-group.json"
G2_ID=$(python -I -c "import uuid; print(uuid.uuid4())")
printf '{"id":"%s","owner_id":"%s","name":"Acceptance Rules Group"}' "$G2_ID" "$RELAY_OWNER_ID" > "$SPG"
rc=$(curl -s -m 20 -o "$TMP_DIR/atspg" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_groups" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$SPG")
printf '{"group_id":"%s","muse_recipient":"%s","name":"Acceptance SA"}\n{"group_id":"%s","muse_recipient":"%s","name":"Acceptance SB"}\n' \
  "$G2_ID" "$SP_A_REC" "$G2_ID" "$SP_B_REC" > "$SPG"
ND_ROWS=0
while IFS= read -r line; do
  printf '%s' "$line" > "$SPG.one"
  rc2=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/relay_group_members" \
    -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$SPG.one")
  [ "$rc2" = "201" ] && ND_ROWS=$((ND_ROWS+1))
done < "$SPG"
rm -f "$SPG" "$SPG.one"
[ "$rc" = "201" ] && [ "$ND_ROWS" = "2" ] && ok "T-SP1 rules group + 2 members created" || bad "T-SP1 group=$rc members=$ND_ROWS"

# T-SPa: the group's FIRST send (record-only, no mention) generates + stores
# the regulation text on relay_groups.rules. ASCII anchors only (roster names,
# output.text, @all) because the rules text itself is Vietnamese UTF-8.
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] sp m1 hello"}}' "$G2_ID" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
SP_RULES=$(curl -s -m 20 "$BASE/rest/v1/relay_groups?select=rules&id=eq.$G2_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
SP_RULES_OK=$(echo "$SP_RULES" | jqpy "import json,sys; rows=json.load(sys.stdin); r=(rows[0].get('rules') or '') if rows else ''; print(len(rows)==1 and len(r)>200 and 'Acceptance Rules Group' in r and '@Acceptance SA' in r and '@Acceptance SB' in r and 'output.text' in r and '@all' in r and 'agent' in r)")
[ "$SPSUB" = "201" ] && [ "$SP_RULES_OK" = "True" ] && ok "T-SPa first group send stores rules (name + roster + agent wording)" || bad "T-SPa got $SPSUB rules=$SP_RULES"

# m2: owner @SA -> SA's first claim carries system_prompt + m1 in history,
# while the legacy `message` shape stays intact.
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] sp m2 @Acceptance SA start"}}' "$G2_ID" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
set -- $(cat "$TMP_DIR/atspq" | jqpy "import json,sys; print(' '.join(json.load(sys.stdin).get('message_ids',[])))")
SP_M2=${1:-}
SPCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_A_TOKEN" -H 'content-type: application/json' -d '{}')
SP_A_ID=$(echo "$SPCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
SP_A_CLAIM=$(echo "$SPCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
SP_A_SP=$(echo "$SPCLAIM" | jqpy "import json,sys; g=json.load(sys.stdin).get('group') or {}; print(g.get('system_prompt') or '')")
SP_A_SHAPE=$(echo "$SPCLAIM" | jqpy "import json,sys; d=json.load(sys.stdin); m=(d.get('message') or {}); p=(m.get('params') or {}); print(m.get('id','')!='' and m.get('claim_id','')!='' and m.get('action')=='chat' and p.get('thread_id')=='$G2_ID' and isinstance(d.get('group'),dict))")
[ "$SPSUB" = "201" ] && [ "$SP_A_ID" = "$SP_M2" ] && [ "$SP_A_SHAPE" = "True" ] && ok "T-SPb first claim: message shape intact + group key present" || bad "T-SPb got $SPSUB id=$SP_A_ID shape=$SP_A_SHAPE"
SP_A_HIST=$(echo "$SPCLAIM" | jqpy "import json,sys; h=(json.load(sys.stdin).get('group') or {}).get('history') or []; print(';'.join(i['kind']+':'+i['text'] for i in h))")
echo "$SP_A_SP" | grep -q 'Acceptance Rules Group' && [ "$SP_A_HIST" = "owner:[ACCEPTANCE] sp m1 hello" ] && ok "T-SPc first claim history = prior record-only utterance, oldest first" || bad "T-SPc sp=[$SP_A_SP] hist=[$SP_A_HIST]"

# SA replies r1 (no mention -> owner-only), then owner @SB: SB's first claim
# must see m1 + r1 + m2 in order.
SPREP="$TMP_DIR/acceptance-sp-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"SA reply r1 no mention"},"error":null}' "$SP_A_ID" "$SP_A_CLAIM" > "$SPREP"
SPRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $SP_A_TOKEN" -H 'content-type: application/json' -d @"$SPREP")
rm -f "$SPREP"
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] sp m3 @Acceptance SB join"}}' "$G2_ID" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
SP_B_M3=$(cat "$TMP_DIR/atspq" | jqpy "import json,sys; ids=json.load(sys.stdin).get('message_ids',[]); print(ids[0] if ids else '')")
SPBCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_B_TOKEN" -H 'content-type: application/json' -d '{}')
SP_B_ID=$(echo "$SPBCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
SP_B_CLAIM=$(echo "$SPBCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
SP_B_SP=$(echo "$SPBCLAIM" | jqpy "import json,sys; g=json.load(sys.stdin).get('group') or {}; print(bool(g.get('system_prompt')))")
SP_B_HIST=$(echo "$SPBCLAIM" | jqpy "import json,sys; h=(json.load(sys.stdin).get('group') or {}).get('history') or []; print(';'.join(i['kind'] for i in h))")
# Chronological order: m1 (owner), m2 (owner @SA), r1 (SA's reply — result time
# lands after m2's post), so the kinds are owner,owner,muse.
[ "$SPSUB" = "201" ] && [ "$SP_B_ID" = "$SP_B_M3" ] && [ "$SP_B_SP" = "True" ] && [ "$SP_B_HIST" = "owner;owner;muse" ] && ok "T-SPd late muse first claim: rules + full history (m1,m2,r1)" || bad "T-SPd got $SPSUB id=$SP_B_ID sp=$SP_B_SP hist=[$SP_B_HIST]"

# SB replies r2 @SA -> SA's delivery row; SA's SECOND claim: no system_prompt
# again, and the current muse reply is NOT duplicated into history (only the
# owner utterance SA missed comes back).
SPREP="$TMP_DIR/acceptance-sp-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"SB passes back to @Acceptance SA"},"error":null}' "$SP_B_ID" "$SP_B_CLAIM" > "$SPREP"
SPRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $SP_B_TOKEN" -H 'content-type: application/json' -d @"$SPREP")
rm -f "$SPREP"
SP_M4=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&recipient=eq.$SP_A_REC&status=eq.pending" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; rows=json.load(sys.stdin); print(rows[0]['id'] if rows else '')")
SPCLAIM2=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_A_TOKEN" -H 'content-type: application/json' -d '{}')
SP_A2_ID=$(echo "$SPCLAIM2" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
SP_A2_CLAIM=$(echo "$SPCLAIM2" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
SP_A2_SP=$(echo "$SPCLAIM2" | jqpy "import json,sys; d=json.load(sys.stdin); g=d.get('group') or {}; print(g.get('system_prompt') is None)")
SP_A2_HIST=$(echo "$SPCLAIM2" | jqpy "import json,sys; h=(json.load(sys.stdin).get('group') or {}).get('history') or []; print(';'.join(i['kind']+':'+i['text'] for i in h))")
[ "$SP_A2_ID" = "$SP_M4" ] && [ "$SP_A2_SP" = "True" ] && [ "$SP_A2_HIST" = "owner:[ACCEPTANCE] sp m3 @Acceptance SB join" ] && ok "T-BFa returning claim: no rules re-send, current reply deduped, missed owner utterance delivered" || bad "T-BFa id=$SP_A2_ID/$SP_M4 sp_null=$SP_A2_SP hist=[$SP_A2_HIST]"

# SA speaks alone (no mention), owner speaks to SA again, then owner @SB:
# SB's next claim backfills BOTH the muse reply it never received AND the
# owner utterance addressed to SA.
SPREP="$TMP_DIR/acceptance-sp-rep.json"
printf '{"message_id":"%s","claim_id":"%s","status":"done","output":{"dropbox_paths":[],"notes":null,"text":"SA thinks alone r3"},"error":null}' "$SP_A2_ID" "$SP_A2_CLAIM" > "$SPREP"
SPRES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $SP_A_TOKEN" -H 'content-type: application/json' -d @"$SPREP")
rm -f "$SPREP"
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] sp m5 @Acceptance SA again"}}' "$G2_ID" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_A_TOKEN" -H 'content-type: application/json' -d '{}' > /dev/null
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"group_id":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] sp m6 @Acceptance SB wrap"}}' "$G2_ID" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
SP_B_M6=$(cat "$TMP_DIR/atspq" | jqpy "import json,sys; ids=json.load(sys.stdin).get('message_ids',[]); print(ids[0] if ids else '')")
SPBCLAIM2=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_B_TOKEN" -H 'content-type: application/json' -d '{}')
SP_B2_ID=$(echo "$SPBCLAIM2" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
SP_B2_SP=$(echo "$SPBCLAIM2" | jqpy "import json,sys; d=json.load(sys.stdin); g=d.get('group') or {}; print(g.get('system_prompt') is None)")
SP_B2_HIST=$(echo "$SPBCLAIM2" | jqpy "import json,sys; h=(json.load(sys.stdin).get('group') or {}).get('history') or []; print(';'.join(i['kind']+':'+i['text'] for i in h))")
[ "$SP_B2_ID" = "$SP_B_M6" ] && [ "$SP_B2_SP" = "True" ] && [ "$SP_B2_HIST" = "muse:SA thinks alone r3;owner:[ACCEPTANCE] sp m5 @Acceptance SA again" ] && ok "T-BFb backfill covers missed muse reply + missed owner utterance, ordered" || bad "T-BFb id=$SP_B2_ID/$SP_B_M6 sp_null=$SP_B2_SP hist=[$SP_B2_HIST]"

SPCUR=$(curl -s -m 20 "$BASE/rest/v1/relay_group_members?select=last_seen_at&group_id=eq.$G2_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
SPCUR_N=$(echo "$SPCUR" | jqpy "import json,sys; rows=json.load(sys.stdin); print(len(rows)==2 and all(r.get('last_seen_at') for r in rows))")
[ "$SPCUR_N" = "True" ] && ok "T-BFc per-member delivery cursor stamped (last_seen_at set x2)" || bad "T-BFc cursors=$SPCUR"

# Direct-path regression: a non-group claim must NOT carry the group key.
SPQ="$TMP_DIR/acceptance-sp-q.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] bf direct"}}' "$SP_B_REC" > "$SPQ"
SPSUB=$(curl -s -m 20 -o "$TMP_DIR/atspq" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$SPQ")
rm -f "$SPQ"
SPDCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $SP_B_TOKEN" -H 'content-type: application/json' -d '{}')
SP_D_OK=$(echo "$SPDCLAIM" | jqpy "import json,sys; d=json.load(sys.stdin); print((d.get('message') or {}).get('id','')!='' and 'group' not in d)")
[ "$SPSUB" = "201" ] && [ "$SP_D_OK" = "True" ] && ok "T-BFd direct chat claim has NO group key (legacy shape)" || bad "T-BFd got $SPSUB resp=$(echo "$SPDCLAIM" | head -c 200)"

echo "== cleanup T-SP/T-BF rows =="
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=in.($SP_A_REC,$SP_B_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=eq.$RELAY_OWNER_ID&params->>thread_id=eq.$G2_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_groups?id=eq.$G2_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_muses?recipient=in.($SP_A_REC,$SP_B_REC)" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-SP/T-BF =="

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

echo "== T-UC: machine command param on chat (/usage quota-check flow) =="
UCSUB=$(curl -s -m 20 -o "$TMP_DIR/atuc" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] uc direct\",\"command\":\"usage\"}}")
UC_ID=$(cat "$TMP_DIR/atuc" | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
UCROW=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=params&id=eq.$UC_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
UC_OK=$(echo "$UCROW" | jqpy "import json,sys; rows=json.load(sys.stdin); p=(rows[0]['params'] if rows else {}); print(len(rows)==1 and p.get('command')=='usage' and p.get('prompt')=='[ACCEPTANCE] uc direct')")
[ "$UCSUB" = "201" ] && [ "$UC_OK" = "True" ] && ok "T-UCa direct chat command=usage -> 201, signed params carry it" || bad "T-UCa got $UCSUB row=$UCROW"
# The LG queue must be empty again before T2/T4 (claim ordering asserts on it).
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$UC_ID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null

UCBAD=$(curl -s -m 20 -o "$TMP_DIR/atucb" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"recipient\":\"$LG_REC\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] uc hack\",\"command\":\"hack\"}}")
UCB_ERR=$(cat "$TMP_DIR/atucb" | jqpy "import json,sys; print(json.load(sys.stdin).get('error',''))")
UCB_N=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id&params->>prompt=eq.%5BACCEPTANCE%5D%20uc%20hack" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jqpy "import json,sys; print(len(json.load(sys.stdin)))")
[ "$UCBAD" = "400" ] && echo "$UCB_ERR" | grep -q 'command' && [ "$UCB_N" = "0" ] && ok "T-UCb command='hack' -> 400 (no row created)" || bad "T-UCb got $UCBAD err=$UCB_ERR rows=$UCB_N"

# Group fan-out must bake the command into the HMAC-signed params at insert
# time (params can never be patched onto rows afterwards). Minimal group:
# LG's muse row is reused as the single member, so @Acceptance LG resolves.
UCG="$TMP_DIR/acceptance-uc-group.json"
UC_GID=$(python -I -c "import uuid; print(uuid.uuid4())")
printf '{"id":"%s","owner_id":"%s","name":"Acceptance UC Group"}' "$UC_GID" "$RELAY_OWNER_ID" > "$UCG"
UCGC=$(curl -s -m 20 -o "$TMP_DIR/atucg" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_groups" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$UCG")
rm -f "$UCG"
printf '{"group_id":"%s","muse_recipient":"%s","name":"Acceptance LG"}' "$UC_GID" "$LG_REC" > "$UCG"
UCMC=$(curl -s -m 20 -o "$TMP_DIR/atucg2" -w '%{http_code}' -X POST "$BASE/rest/v1/relay_group_members" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$UCG")
rm -f "$UCG"
UCSUB2=$(curl -s -m 20 -o "$TMP_DIR/atucg3" -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d "{\"group_id\":\"$UC_GID\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] uc group @Acceptance LG usage\",\"command\":\"usage\"}}")
UCGROW=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=params&recipient=eq.$LG_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
UCG_OK=$(echo "$UCGROW" | jqpy "import json,sys; rows=json.load(sys.stdin); p=(rows[0]['params'] if rows else {}); print(len(rows)==1 and p.get('command')=='usage' and p.get('thread_id')=='$UC_GID')")
[ "$UCGC" = "201" ] && [ "$UCMC" = "201" ] && [ "$UCSUB2" = "201" ] && [ "$UCG_OK" = "True" ] && ok "T-UCc group fan-out @Acceptance LG -> 201, command carried in signed params" || bad "T-UCc group=$UCGC member=$UCMC sub=$UCSUB2 row=$UCGROW"
# Cleanup: messages (LG delivery + owner rows by thread_id) first — deleting
# them cascades the relay_group_posts rows — then the group cascades members.
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=eq.$LG_REC" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?recipient=eq.$RELAY_OWNER_ID&params->>thread_id=eq.$UC_GID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_groups?id=eq.$UC_GID" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
echo "== end T-UC =="

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