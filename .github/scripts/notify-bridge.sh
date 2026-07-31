#!/usr/bin/env bash
# notify-bridge — post a CI event to the Skymoss bridge, HMAC-signed.
#
#   ./notify-bridge.sh --kind release --status success --name "Release v0.1.0" \
#                      --version 0.1.0 --url https://…
#
# Requires BRIDGE_URL and CI_EVENT_SECRET in the environment.
#
# Never fails the calling job: a Discord notification is a nicety, and a bridge that
# happens to be down should not turn a green release red. Problems are reported to
# the step log instead.

set -uo pipefail

KIND=""
STATUS=""
NAME=""
VERSION=""
URL=""
DETAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)    KIND="$2";    shift 2 ;;
    --status)  STATUS="$2";  shift 2 ;;
    --name)    NAME="$2";    shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --url)     URL="$2";     shift 2 ;;
    --detail)  DETAIL="$2";  shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 0 ;;
  esac
done

if [[ -z "${BRIDGE_URL:-}" || -z "${CI_EVENT_SECRET:-}" ]]; then
  echo "notify-bridge: BRIDGE_URL or CI_EVENT_SECRET not set — skipping notification"
  exit 0
fi

PAYLOAD=$(jq -nc \
  --arg kind    "$KIND" \
  --arg status  "$STATUS" \
  --arg name    "$NAME" \
  --arg version "$VERSION" \
  --arg url     "$URL" \
  --arg detail  "$DETAIL" \
  '{kind:$kind, status:$status, name:$name, version:$version, url:$url, detail:$detail}
   | with_entries(select(.value != ""))')

# The signature covers the exact bytes sent; the bridge recomputes it over the raw
# request body, so the payload must not be re-serialized anywhere in between.
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$CI_EVENT_SECRET" -r | cut -d' ' -f1)"

CODE=$(curl -sS -o /tmp/notify-body -w '%{http_code}' \
  -X POST "${BRIDGE_URL%/}/events" \
  -H 'Content-Type: application/json' \
  -H "X-Skymoss-Signature: $SIG" \
  --max-time 15 \
  -d "$PAYLOAD" || echo "000")

if [[ "$CODE" =~ ^2 ]]; then
  echo "notify-bridge: delivered ($CODE)"
else
  echo "notify-bridge: delivery failed (HTTP $CODE)"
  cat /tmp/notify-body 2>/dev/null || true
fi

exit 0
