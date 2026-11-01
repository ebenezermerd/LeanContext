<!-- leancontext:start (source: ~/Developer/LeanContext/config/agent-rules.md) -->
## Web search (searchq queue)

- Search the web only with the `searchq` MCP tool `web_search` (CLI fallback: `searchq "query"`). The built-in WebSearch is disabled on purpose; don't route around the queue with other search tools unless searchq reports SEARCH_UNAVAILABLE.
- Every search goes through a shared, rate-limited queue. A slow call means the request is queued, not that it failed. Always wait for the response; never skip, abandon or retry a search because it is taking long.
- A search has failed only when the result starts with `SEARCH_FAILED`, `SEARCH_UNAVAILABLE` or `SEARCH_TIMEOUT`. An empty result list is a real answer: rephrase once, then move on.
- Send searches one at a time and reuse earlier results; identical queries are cached for an hour.

## Context budget

- Read files by range and search before reading whole files; don't re-read a file you just edited.
- Prefer `jq`/`rg`/`head` filters over dumping full JSON or logs into context.
- When a task is done or the context is long, run `/handoff` to write a compact handoff, then start fresh from it.
<!-- leancontext:end -->
