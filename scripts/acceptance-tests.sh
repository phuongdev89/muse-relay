#!/usr/bin/env bash
# Acceptance tests (step 5 of Muse's README) — run against the live project.
# Prints verdicts only; never prints tokens, emails, or JWTs.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="$SUPABASE_URL"
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
jqpy(){ python -I -c "$1"; }

echo "== T1: unauthenticated calls must get 401 =="
c=$(curl -s -m 20 -o /tmp/at1a -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" -H 'content-type: application/json' -d '{"action":"image","params":{"prompt":"x"}}')
[ "$c" = "401" ] && ok "T1 submit_message no-auth -> 401" || bad "T1 submit_message got $c: $(head -c 120 /tmp/at1a)"
c=$(curl -s -m 20 -o /tmp/at1b -w '%{http_code}' -X POST "$BASE/functions/v1/claim_message" -H 'content-type: application/json' -d '{}')
[ "$c" = "401" ] && ok "T1 claim_message no-token -> 401" || bad "T1 claim_message got $c: $(head -c 120 /tmp/at1b)"
c=$(curl -s -m 20 -o /tmp/at1c -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" -H 'content-type: application/json' -d '{}')
[ "$c" = "401" ] && ok "T1 submit_result no-token -> 401" || bad "T1 submit_result got $c: $(head -c 120 /tmp/at1c)"

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

echo "== T-MM: multi-muse registry + queue isolation =="
MM_REC=$(python -I -c "import uuid; print(uuid.uuid4())")
MM_TOKEN=$(python -I -c "import secrets; print(secrets.token_hex(32))")
export MM_TOKEN
MM_HASH=$(python -I -c "import hashlib,os; print(hashlib.sha256(os.environ['MM_TOKEN'].encode()).hexdigest())")
MM_ROOT="/acceptance-mm-muse/"
MMB=".scratch/acceptance-mm-muse.json"
printf '{"owner_id":"%s","recipient":"%s","name":"Acceptance MM","token_hash":"%s","dropbox_root":"%s"}' \
  "$RELAY_OWNER_ID" "$MM_REC" "$MM_HASH" "$MM_ROOT" > "$MMB"
MMC=$(curl -s -m 20 -o /tmp/atmma -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -H 'Prefer: return=minimal' -d @"$MMB")
rm -f "$MMB"
[ "$MMC" = "201" ] && ok "T-MMa wizard-style registry insert (owner JWT) -> 201" || bad "T-MMa insert got $MMC: $(head -c 200 /tmp/atmma)"
ANONC=$(curl -s -m 20 -o /tmp/atmmz -w '%{http_code}' -X POST "$BASE/rest/v1/relay_muses" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"owner_id":"00000000-0000-0000-0000-000000000000","recipient":"11111111-1111-4111-8111-111111111111","name":"x","token_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dropbox_root":"/x/"}')
[ "$ANONC" != "201" ] && ok "T-MMb anonymous insert blocked by RLS ($ANONC)" || bad "T-MMb anon insert unexpectedly created a row"
ANONG=$(curl -s -m 20 "$BASE/rest/v1/relay_muses?select=recipient" -H "apikey: $SUPABASE_PUBLISHABLE_KEY")
[ "$ANONG" = "[]" ] && ok "T-MMc anonymous read of registry -> [] (RLS)" || bad "T-MMc anon read leaked: $ANONG"

MMQ=".scratch/acceptance-mm-q.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] mm queue"}}' "$MM_REC" > "$MMQ"
MSUB=$(curl -s -m 20 -o /tmp/atmmb -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$MMQ")
MSG_M1=$(cat /tmp/atmmb | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$MSUB" = "201" ] && [ -n "$MSG_M1" ] && ok "T-MMd submit to registered muse -> 201" || bad "T-MMd got $MSUB: $(head -c 200 /tmp/atmmb)"

ISO1=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d '{}')
ISO1N=$(echo "$ISO1" | jqpy "import json,sys; print(json.load(sys.stdin).get('message') is None)")
[ "$ISO1N" = "True" ] && ok "T-MMe Nyx token does NOT see other muse's queue" || bad "T-MMe Nyx claimed foreign message: $(echo "$ISO1" | head -c 200)"
MCLAIM=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' -d '{}')
MC_ID=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
MC_CLAIM=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
MC_REC=$(echo "$MCLAIM" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('recipient',''))")
[ "$MC_ID" = "$MSG_M1" ] && [ "$MC_REC" = "$MM_REC" ] && [ -n "$MC_CLAIM" ] && ok "T-MMf own token claims own message (recipient echoed)" || bad "T-MMf claim: $(echo "$MCLAIM" | head -c 200)"

MM_ROOTNEG=$(curl -s -m 20 -o /tmp/atmmc -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_M1\",\"claim_id\":\"$MC_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/nolanthomas825cxoz@lappies.net/t-mm/steal.png\"],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$MM_ROOTNEG" = "400" ] && ok "T-MMg foreign dropbox root rejected -> 400" || bad "T-MMg got $MM_ROOTNEG: $(head -c 200 /tmp/atmmc)"
MM_OWN=$(curl -s -m 20 -o /tmp/atmmd -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_M1\",\"claim_id\":\"$MC_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$MM_OWN" = "403" ] && ok "T-MMh Nyx token cannot submit result for other muse -> 403" || bad "T-MMh got $MM_OWN: $(head -c 200 /tmp/atmmd)"
MM_ERRBODY=".scratch/acceptance-mm-err.json"
printf '{"message_id":"%s","claim_id":"%s","status":"failed","output":{"dropbox_paths":[],"notes":null,"text":null},"error_code":"out_of_scope"}' "$MSG_M1" "$MC_CLAIM" > "$MM_ERRBODY"
MM_ERR=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $MM_TOKEN" -H 'content-type: application/json' -d @"$MM_ERRBODY")
rm -f "$MM_ERRBODY"
MM_ERR_OK=$(echo "$MM_ERR" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
MM_ERR_DB=$(curl -s -m 20 "$BASE/rest/v1/relay_results?select=error&message_id=eq.$MSG_M1" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
echo "$MM_ERR_DB" | grep -q 'out_of_scope' && [ "$MM_ERR_OK" = "True" ] && ok "T-MMi error_code-only failed result accepted (out_of_scope)" || bad "T-MMi res=$MM_ERR db=$MM_ERR_DB"

MMQ2=".scratch/acceptance-mm-q2.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] mm nyx-queue"}}' "$RELAY_RECIPIENT_ID" > "$MMQ2"
MSUB2=$(curl -s -m 20 -o /tmp/atmme -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d @"$MMQ2")
MSG_M2=$(cat /tmp/atmme | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
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

echo "== T2: signed submit -> 201 + message_id + pending row =="
SUB_BODY='{"action":"image","params":{"prompt":"[ACCEPTANCE] t2 image","aspect_ratio":"1:1","count":1,"reference_storage_paths":[]}}'
SUB=$(curl -s -m 20 -o /tmp/at2 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' -d "$SUB_BODY")
MSG_A=$(cat /tmp/at2 | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
SUB2=$(curl -s -m 20 -o /tmp/at2b -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"video","params":{"prompt":"[ACCEPTANCE] t3 tamper","aspect_ratio":"16:9","duration_seconds":5,"reference_storage_paths":[]}}')
MSG_B=$(cat /tmp/at2b | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
if [ "$SUB" = "201" ] && [ -n "$MSG_A" ] && [ "$SUB2" = "201" ] && [ -n "$MSG_B" ]; then
  ok "T2 submit -> 201, message_id A=$MSG_A / B=$MSG_B"
else
  bad "T2 submit got ($SUB / $SUB2): $(head -c 200 /tmp/at2)"; exit 1
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
CLAIM1=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d '{}')
C1_ID=$(echo "$CLAIM1" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
C1_CLAIM=$(echo "$CLAIM1" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
[ "$C1_ID" = "$MSG_A" ] && [ -n "$C1_CLAIM" ] && ok "T4a claim#1 returned A with claim_id" || bad "T4a claim#1: $(echo "$CLAIM1" | head -c 200)"
CLAIM2=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d '{}')
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
c=$(curl -s -m 20 -o /tmp/at5 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"00000000-0000-0000-0000-000000000000\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null},\"error\":null}")
ERR5=$(cat /tmp/at5 | jqpy "import json,sys; print(json.load(sys.stdin).get('error',''))")
[ "$c" = "409" ] && ok "T5 wrong claim_id -> 409 ($ERR5)" || bad "T5 got $c: $(head -c 200 /tmp/at5)"

echo "== T-media-neg: image done without dropbox_paths must 400 =="
c=$(curl -s -m 20 -o /tmp/atm -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result"   -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json'   -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"$C1_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null},\"error\":null}")
[ "$c" = "400" ] && ok "T-media-neg image done w/o paths -> 400" || bad "T-media-neg got $c: $(head -c 200 /tmp/atm)"

echo "== bonus: happy-path submit_result with correct claim_id =="
RES=$(curl -s -m 20 -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_A\",\"claim_id\":\"$C1_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/nolanthomas825cxoz@lappies.net/t-acceptance/2026-11-27_acceptance.png\"],\"notes\":\"acceptance test\"},\"error\":null}")
AOK=$(echo "$RES" | jqpy "import json,sys; print(json.load(sys.stdin).get('ok', False))")
AA=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=status&id=eq.$MSG_A" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
[ "$AOK" = "True" ] && echo "$AA" | grep -q '"done"' && ok "bonus: correct claim -> done + row done" || bad "bonus: res=$RES row=$AA"

echo "== T6: chat action end-to-end =="
SUBC=$(curl -s -m 20 -o /tmp/at6 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"chat","params":{"prompt":"[ACCEPTANCE] t6 chat"}}')
MSG_C=$(cat /tmp/at6 | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
if [ "$SUBC" = "201" ] && [ -n "$MSG_C" ]; then
  ok "T6a chat submit -> 201, message_id C=$MSG_C"
else
  bad "T6a chat submit got $SUBC: $(head -c 200 /tmp/at6)"
fi
CLAIMC=$(curl -s -m 20 -X POST "$BASE/functions/v1/claim_message" -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d '{}')
C_ID=$(echo "$CLAIMC" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('id',''))")
C_CLAIM=$(echo "$CLAIMC" | jqpy "import json,sys; m=(json.load(sys.stdin).get('message') or {}); print(m.get('claim_id',''))")
if [ "$C_ID" = "$MSG_C" ] && [ -n "$C_CLAIM" ]; then
  ok "T6b chat claim -> claimed with claim_id"
else
  bad "T6b chat claim: $(echo "$CLAIMC" | head -c 200)"
fi
echo "== T-chat-neg: chat done without text must 400 =="
c=$(curl -s -m 20 -o /tmp/atcn -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result"   -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json'   -d "{\"message_id\":\"$MSG_C\",\"claim_id\":\"$C_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[],\"notes\":null,\"text\":\"   \"},\"error\":null}")
[ "$c" = "400" ] && ok "T-chat-neg chat done w/o text -> 400" || bad "T-chat-neg got $c: $(head -c 200 /tmp/atcn)"

RESC_BODY=".scratch/acceptance-res-body.json"
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
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' -d @"$RESC_BODY")
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
c=$(curl -s -m 20 -o /tmp/at7 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"audio","params":{"prompt":"x"}}')
[ "$c" = "400" ] && ok "T7 action 'audio' -> 400" || bad "T7 got $c: $(head -c 200 /tmp/at7)"

echo "== T8: dropbox_paths outside new prefix must be 400 =="
c=$(curl -s -m 20 -o /tmp/at8 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_result" \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "{\"message_id\":\"$MSG_C\",\"claim_id\":\"$C_CLAIM\",\"status\":\"done\",\"output\":{\"dropbox_paths\":[\"/MuseRelay/outputs/old/old.png\"],\"notes\":null,\"text\":\"x\"},\"error\":null}")
[ "$c" = "400" ] && ok "T8 old prefix /MuseRelay/outputs/ -> 400" || bad "T8 got $c: $(head -c 200 /tmp/at8)"

echo "== T9: thread_id accepted + bad thread_id rejected =="
SUBT=$(curl -s -m 20 -o /tmp/at9a -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"image","params":{"prompt":"[ACCEPTANCE] t9 thread","thread_id":"cat-climbing-01","reference_storage_paths":[]}}')
MSG_T=$(cat /tmp/at9a | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBT" = "201" ] && [ -n "$MSG_T" ] && ok "T9a submit with thread_id -> 201" || bad "T9a got $SUBC: $(head -c 200 /tmp/at9a)"
c=$(curl -s -m 20 -o /tmp/at9b -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message" \
  -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"action":"image","params":{"prompt":"[ACCEPTANCE] t9 bad","thread_id":"bad id!!","reference_storage_paths":[]}}')
[ "$c" = "400" ] && ok "T9b bad thread_id -> 400" || bad "T9b got $c: $(head -c 200 /tmp/at9b)"

echo "== T10: recipient mismatch -> 403 / match -> 201 =="
c=$(curl -s -m 20 -o /tmp/at10a -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d '{"recipient":"00000000-0000-0000-0000-000000000000","action":"chat","params":{"prompt":"[ACCEPTANCE] t10 mismatch"}}')
[ "$c" = "403" ] && ok "T10a wrong recipient -> 403" || bad "T10a got $c: $(head -c 200 /tmp/at10a)"
T10B=".scratch/acceptance-t10b.json"
printf '{"recipient":"%s","action":"chat","params":{"prompt":"[ACCEPTANCE] t10 match"}}' "$RELAY_RECIPIENT_ID" > "$T10B"
SUBR=$(curl -s -m 20 -o /tmp/at10b -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d @"$T10B")
rm -f "$T10B"
MSG_R=$(cat /tmp/at10b | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBR" = "201" ] && [ -n "$MSG_R" ] && ok "T10b correct recipient -> 201" || bad "T10b got $SUBR: $(head -c 200 /tmp/at10b)"

echo "== T11: rich chat (document/csv/thread) -> 201 =="
SUBD=$(curl -s -m 20 -o /tmp/at11 -w '%{http_code}' -X POST "$BASE/functions/v1/submit_message"   -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json'   -d "{\"recipient\":\"$RELAY_RECIPIENT_ID\",\"action\":\"chat\",\"params\":{\"prompt\":\"[ACCEPTANCE] t11 doc\",\"thread_id\":\"t11-doc\",\"resource_type\":\"document\",\"output_format\":\"csv\"}}")
MSG_D=$(cat /tmp/at11 | jqpy "import json,sys; print(json.load(sys.stdin).get('message_id',''))")
[ "$SUBD" = "201" ] && [ -n "$MSG_D" ] && ok "T11 rich chat -> 201" || bad "T11 got $SUBD: $(head -c 200 /tmp/at11)"

echo "== cleanup test rows =="
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_A" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_B" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_C:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_C" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_T:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_T" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_R:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_R" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
[ -n "${MSG_D:-}" ] && curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?id=eq.$MSG_D" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" > /dev/null
# Final sweep: delete ANY leftover acceptance rows (Nyx daemon is LIVE and claims leftovers as real work).
curl -s -m 20 -X DELETE "$BASE/rest/v1/relay_messages?params->>prompt=like.%5BACCEPTANCE%5D*" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Prefer: return=minimal" > /dev/null
LEFT=$(curl -s -m 20 "$BASE/rest/v1/relay_messages?select=id" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY")
echo "relay_messages now: $LEFT"

echo "=============================="
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]