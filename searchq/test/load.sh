#!/usr/bin/env bash
# Fires N distinct queries at once. Expect: zero failures, waits that grow as the buckets drain.
N=${1:-15}; URL=${SEARCHQ_URL:-http://127.0.0.1:8787}
for i in $(seq 1 "$N"); do
  ( curl -s -X POST "$URL/search" -H 'content-type: application/json' \
      -d "{\"q\":\"load test query $i $RANDOM\",\"max\":2}" \
    | jq -c --arg i "$i" '{i:$i, backend, waitedMs, n:(.results|length), error}' ) &
done
wait
curl -s "$URL/health" | jq -c .
