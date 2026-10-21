#!/usr/bin/env bash
# Prints a GitHub App installation token, so a routine can post as your-app[bot] instead of as
# the person who set it up. The token lasts an hour; mint a new one each run.
#
# Usage: app-token.sh --repo owner/name [--repo owner/other] [--jwt-only]
#   --repo       a repo the token is for. The app must be installed on it. All repos must share
#                one installation (the same owner). Repeat for each repo the run touches.
#   --jwt-only   print the app's signed JWT instead, without calling GitHub (for testing).
#
# Reads, from the environment:
#   LOOP_APP_ID        the app's ID, from its settings page
#   LOOP_APP_KEY       the app's private key, the whole PEM text
#     or LOOP_APP_KEY_FILE, a path to it
#   LOOP_GITHUB_API    optional, defaults to https://api.github.com
#
# In a routine session:
#   export GH_TOKEN="$(bash ~/.loop/app-token.sh --repo owner/name)"
#   gh issue comment 12 -R owner/name --body "..."    # posts as your-app[bot]
#
# Needs bash, curl, jq, and openssl. Exits non-zero with a reason on stderr; prints nothing else.
set -euo pipefail

API="${LOOP_GITHUB_API:-https://api.github.com}"
repos=()
jwt_only=no
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repos+=("${2:-}"); shift 2 ;;
    --jwt-only) jwt_only=yes; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "app-token: $*" >&2; exit 1; }

[ -n "${LOOP_APP_ID:-}" ] || fail "LOOP_APP_ID isn't set"
for tool in curl jq openssl; do command -v "$tool" >/dev/null || fail "$tool isn't installed"; done

key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT
chmod 600 "$key_file"
if [ -n "${LOOP_APP_KEY:-}" ]; then
  printf '%s\n' "$LOOP_APP_KEY" > "$key_file"
elif [ -n "${LOOP_APP_KEY_FILE:-}" ] && [ -r "$LOOP_APP_KEY_FILE" ]; then
  cp "$LOOP_APP_KEY_FILE" "$key_file"
else
  fail "set LOOP_APP_KEY (the PEM text) or LOOP_APP_KEY_FILE (a path to it)"
fi

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# GitHub's rules: issued at most 60 seconds in the past (allows for clock drift), expiring
# within 10 minutes, signed RS256, with the app ID as the issuer.
now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$LOOP_APP_ID" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$key_file" -binary 2>/dev/null | b64url)" \
  || fail "couldn't sign with the private key; is it the app's PEM?"
[ -n "$signature" ] || fail "couldn't sign with the private key; is it the app's PEM?"
jwt="$header.$payload.$signature"

if [ "$jwt_only" = yes ]; then
  printf '%s\n' "$jwt"
  exit 0
fi

[ "${#repos[@]}" -gt 0 ] || fail "give at least one --repo owner/name"

call() {
  local method="$1" path="$2" body="${3:-}" out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    ${body:+-H "Content-Type: application/json" -d "$body"})" || { rm -f "$out"; fail "couldn't reach $API"; }
  if [ "${code:0:1}" != 2 ]; then
    local msg
    msg="$(jq -r '.message // empty' "$out" 2>/dev/null || true)"
    rm -f "$out"
    fail "$method $path returned HTTP $code${msg:+: $msg}"
  fi
  cat "$out"
  rm -f "$out"
}

installation="$(call GET "/repos/${repos[0]}/installation" | jq -r '.id')"
[ -n "$installation" ] && [ "$installation" != null ] || fail "the app isn't installed on ${repos[0]}"

names="$(printf '%s\n' "${repos[@]}" | sed 's#.*/##' | jq -R . | jq -cs .)"
token="$(call POST "/app/installations/$installation/access_tokens" "{\"repositories\":$names}" | jq -r '.token')"
[ -n "$token" ] && [ "$token" != null ] || fail "GitHub didn't return a token"
printf '%s\n' "$token"
