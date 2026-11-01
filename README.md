# LeanContext

Token minimization for Claude Code and Codex on this Mac: a self-hosted, rate-limited search queue that replaces the built-in web search, plus the config, rules and habits that keep context small.

- Plan and status: [docs/PLAN.md](docs/PLAN.md)
- Strategy: [docs/STRATEGY.md](docs/STRATEGY.md)

## Layout
```
stack/     docker compose: degoog (:4444), 4get (:8088), searchq gateway (:8787), all on 127.0.0.1
searchq/   gateway.ts (queue + rate limiter + cache + failover), mcp.ts (MCP stdio tool), test/load.sh
bin/       searchq CLI (symlinked to ~/.local/bin)
config/    agent-rules.md (source for CLAUDE.md / AGENTS.md), backups of edited configs
```

## Run
```
cd stack && docker compose up -d --build
./bootstrap-degoog.sh            # first run only: installs degoog's search engines
curl -s localhost:8787/health
searchq "your query"
searchq/test/load.sh 15          # burst test
```
`stack/.env` holds the generated degoog settings password (gitignored).

## How a search flows
agent → `web_search` (MCP) → gateway queue (FIFO, max 100, 2 at a time) → token bucket for degoog, else 4get → compact + cache → agent.
A full queue returns 503 with `retryAfterS`; the MCP server and CLI wait and retry, so agents only see a failure after 240s.

## Tuning (env on the searchq service)
`DEGOOG_RATE_PER_MIN` 20, `DEGOOG_BURST` 4, `FOURGET_RATE_PER_MIN` 12, `FOURGET_BURST` 3, `SEARCHQ_CONCURRENCY` 2, `SEARCHQ_CACHE_TTL_S` 3600, `SEARCHQ_SNIPPET_CHARS` 220.
