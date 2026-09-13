#!/usr/bin/env bash
# Verify the darth-auth cutover (SPEC §3 + §4.2) against a locally running app
# whose DARTH_AUTH_URL / DARTH_AUTH_INTERNAL_URL point at scripts/stub-introspect.ts.
#
#   bun scripts/stub-introspect.ts 8791 &
#   ( unset $(env | grep -oE '^(PG|AWS_)[A-Z_]*'); \
#     DARTH_AUTH_URL=http://127.0.0.1:8791 DARTH_AUTH_INTERNAL_URL=http://127.0.0.1:8791 \
#     bun run dev -p 3002 ) &
#   scripts/verify-auth-cutover.sh http://localhost:3002
#
# Read-only: only GET pages/APIs plus one POST that must be REJECTED (403)
# before any handler runs, so no meeting data is touched.
set -uo pipefail

APP="${1:-http://localhost:3002}"
AUTH="${DARTH_AUTH_URL:-http://127.0.0.1:8791}"
pass=0; fail=0

check() { # name expected actual [detail]
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "PASS  $1 → $3 ${4:-}"; else fail=$((fail+1)); echo "FAIL  $1 → got $3, expected $2 ${4:-}"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
hdr()  { curl -s -o /dev/null -D - "$@" | tr -d '\r'; }

DOC=(-H 'accept: text/html' -H 'sec-fetch-dest: document' -H 'sec-fetch-mode: navigate')

echo "== app: $APP  auth: $AUTH"

# 1. no cookie, document nav → 302 to auth login with absolute returnTo
loc=$(hdr "${DOC[@]}" "$APP/settings" | awk 'tolower($1)=="location:"{print $2}')
check "no cookie: GET /settings (document)" "302" "$(code "${DOC[@]}" "$APP/settings")"
check "  Location starts with $AUTH/login?returnTo=" "yes" "$([[ "$loc" == "$AUTH/login?returnTo="* ]] && echo yes || echo "no ($loc)")"
check "  returnTo carries the absolute app URL" "yes" "$([[ "$loc" == *"$(printf '%s' "$APP/settings" | sed 's#:#%3A#g; s#/#%2F#g')"* ]] && echo yes || echo "no ($loc)")"

# 2. no cookie, API / RSC → 401 JSON, never a redirect
check "no cookie: GET /api/whoami" "401" "$(code "$APP/api/whoami")"
check "no cookie: RSC fetch of / (rsc header)" "401" "$(code -H 'rsc: 1' -H 'accept: text/x-component' "$APP/")"
check "no cookie: GET / with Accept: application/json" "401" "$(code -H 'accept: application/json' "$APP/")"

# 3. session with modules [meetings] → page 200 + API 200
FULL="darth_session=dss_stubstubstubstubstubstubstubFULL"
check "session[meetings]: GET /settings (document)" "200" "$(code "${DOC[@]}" -b "$FULL" "$APP/settings")"
check "session[meetings]: GET /api/whoami" "200" "$(code -b "$FULL" "$APP/api/whoami")"
who=$(curl -s -b "$FULL" "$APP/api/whoami")
check "  whoami via=session + modules" "yes" "$([[ "$who" == *'"via":"session"'* && "$who" == *'"modules":["meetings","tasks"]'* ]] && echo yes || echo "no ($who)")"
check "session[meetings]: GET /api/auth/session (introspect object)" "200" "$(code -b "$FULL" "$APP/api/auth/session")"
check "session[meetings]: GET /api/transcripts?limit=1 (read-only DB page)" "200" "$(code -b "$FULL" "$APP/api/transcripts?limit=1")"

# 4. session without meetings → 403 (page + API)
NOMEET="darth_session=dss_stubstubstubstubstubstubstubNOMEET"
check "session[no meetings]: GET /settings (document)" "403" "$(code "${DOC[@]}" -b "$NOMEET" "$APP/settings")"
check "session[no meetings]: GET /api/whoami" "403" "$(code -b "$NOMEET" "$APP/api/whoami")"
check "session[no meetings]: GET /api/transcripts (excluded from proxy; withAuth)" "403" "$(code -b "$NOMEET" "$APP/api/transcripts")"

# 5. invalid / expired session → 401 API, 302 page
check "invalid session: GET /api/whoami" "401" "$(code -b 'darth_session=dss_stubstubstubstubstubstubstubDEAD' "$APP/api/whoami")"
check "invalid session: GET / (document)" "302" "$(code "${DOC[@]}" -b 'darth_session=dss_stubstubstubstubstubstubstubDEAD' "$APP/")"
check "legacy kenoby cookie alone: GET /api/whoami" "401" "$(code -b 'trames-auth-session=eyJhbGciOiJSUzI1NiJ9.e30.x' "$APP/api/whoami")"

# 6. dth_ paths
RW="Authorization: Bearer dth_stubstubstubstubstubstubstubRW"
RO="Authorization: Bearer dth_stubstubstubstubstubstubstubRO"
NM="Authorization: Bearer dth_stubstubstubstubstubstubstubNOMEET"
check "dth_ [meetings, readwrite]: GET /api/whoami" "200" "$(code -H "$RW" "$APP/api/whoami")"
check "dth_ WITHOUT meetings module: GET /api/whoami (bypass closed)" "403" "$(code -H "$NM" "$APP/api/whoami")"
check "dth_ WITHOUT meetings module: GET /api/transcripts (withAuth path)" "403" "$(code -H "$NM" "$APP/api/transcripts")"
check "dth_ read-only: GET /api/whoami" "200" "$(code -H "$RO" "$APP/api/whoami")"
check "dth_ read-only: PUT /api/vocab/user" "403" "$(code -X PUT -H "$RO" -H 'content-type: application/json' -d '{}' "$APP/api/vocab/user")"
check "dth_ invalid: GET /api/whoami" "401" "$(code -H 'Authorization: Bearer dth_stubstubstubstubstubstubstubDEAD' "$APP/api/whoami")"
check "dapp_ bearer: GET /api/whoami" "403" "$(code -H 'Authorization: Bearer dapp_stubstubstubstubstubstubstub' "$APP/api/whoami")"

# 6b. transient introspect failure (darth-auth 500) is denied but NOT cached:
#     the very next call for the same fresh session must succeed.
FRESH="darth_session=dss_stubstubstubstubstubstubFRESHFULL"
curl -s -o /dev/null -X POST "$AUTH/_fail?n=1"
check "introspect 500: GET /api/whoami (denied this once)" "401" "$(code -b "$FRESH" "$APP/api/whoami")"
check "  same session right after (500 was not cached)" "200" "$(code -b "$FRESH" "$APP/api/whoami")"

# 7. login / logout bounce to darth-auth
lloc=$(hdr "$APP/login?returnTo=/transcript/abc" | awk 'tolower($1)=="location:"{print $2}')
check "GET /login?returnTo=/transcript/abc" "302" "$(code "$APP/login?returnTo=/transcript/abc")"
check "  Location = $AUTH/login?returnTo=<abs app url>" "yes" "$([[ "$lloc" == "$AUTH/login?returnTo="*"%2Ftranscript%2Fabc" ]] && echo yes || echo "no ($lloc)")"
appenc=$(printf '%s' "$APP/" | sed 's#:#%3A#g; s#/#%2F#g')
for bad in 'https://evil.example/x' '//evil.example/x' '/\evil.example/x' '/\\evil.example/x' 'http://user@evil.example/'; do
  oloc=$(hdr "$APP/login?returnTo=$bad" | awk 'tolower($1)=="location:"{print $2}')
  check "  returnTo=$bad neutralised to app root" "yes" "$([[ "$oloc" == "$AUTH/login?returnTo=$appenc" ]] && echo yes || echo "no ($oloc)")"
done
# a client-supplied X-Forwarded-Host must not steer returnTo (nginx does not set it)
sloc=$(hdr "${DOC[@]}" -H 'x-forwarded-host: evil.example' "$APP/settings" | awk 'tolower($1)=="location:"{print $2}')
check "  spoofed X-Forwarded-Host ignored in sign-in returnTo" "yes" "$([[ "$sloc" != *"evil.example"* && "$sloc" == *"$(printf '%s' "$APP/settings" | sed 's#:#%3A#g; s#/#%2F#g')"* ]] && echo yes || echo "no ($sloc)")"
sloc=$(hdr -H 'x-forwarded-host: evil.example' "$APP/login?returnTo=/x" | awk 'tolower($1)=="location:"{print $2}')
check "  spoofed X-Forwarded-Host ignored by /login" "yes" "$([[ "$sloc" != *"evil.example"* ]] && echo yes || echo "no ($sloc)")"
gloc=$(hdr "$APP/logout" | awk 'tolower($1)=="location:"{print $2}')
check "GET /logout" "302" "$(code "$APP/logout")"
check "  Location = $AUTH/logout?returnTo=<app root>" "yes" "$([[ "$gloc" == "$AUTH/logout?returnTo="* ]] && echo yes || echo "no ($gloc)")"

echo "== $pass passed, $fail failed"
[[ $fail -eq 0 ]]
