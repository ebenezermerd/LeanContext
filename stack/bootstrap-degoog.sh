#!/usr/bin/env bash
# Installs degoog's web engines from the official extension store.
# degoog ships with no third-party engines enabled, so search returns nothing until this runs.
set -euo pipefail
cd "$(dirname "$0")"
source .env
BASE=${DEGOOG_URL:-http://127.0.0.1:4444}
REPO=https://github.com/degoog-org/official-extensions.git
ENGINES=${DEGOOG_ENGINES:-"duckduckgo brave startpage bing wikipedia"}

token=$(curl -sf -X POST "$BASE/api/settings/auth" -H 'content-type: application/json' \
  -d "{\"password\":\"$DEGOOG_SETTINGS_PASSWORD\"}" | jq -r .token)
[ -n "$token" ] && [ "$token" != null ] || { echo "degoog auth failed" >&2; exit 1; }

for e in $ENGINES; do
  printf '%-12s ' "$e"
  curl -s -X POST "$BASE/api/store/install" -H 'content-type: application/json' \
    -H "x-settings-token: $token" \
    -d "{\"repoUrl\":\"$REPO\",\"itemPath\":\"engines/$e\",\"type\":\"engine\"}"
  echo
done
