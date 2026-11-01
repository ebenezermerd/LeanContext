# LeanContext implementation plan

Goal: cut Claude Code and Codex token use substantially on a Team Pro seat (Opus 5.5, no Fable) without losing accuracy, then measure the effect.

Status key: [x] done and verified, [ ] to do, [~] needs your hand.

## Phase 1: Model routing
- [x] `"model": "opusplan"` in `~/.claude/settings.json`: Opus 5.5 while in plan mode, Sonnet 5.5 for execution. Planning is where the reasoning pays off; execution is mostly edits and commands, where Sonnet costs far less of the usage limit.
- [x] Keep `effortLevel: medium` (already set). Raise per task with `/effort`, not globally.
- [ ] Work in plan mode first on anything multi-step (Shift+Tab twice), so Opus plans once and Sonnet executes.

## Phase 2: Search through a queue (built here)
- [x] Self-hosted degoog (`:4444`, 5 engines: DuckDuckGo, Brave, Startpage, Bing, Wikipedia) and 4get (`:8088`), bound to localhost. `stack/bootstrap-degoog.sh` installs degoog's engines, which it does not ship with.
- [x] `searchq` gateway (`:8787`): one FIFO queue for every agent on the machine, token-bucket rate limit per backend (degoog 20/min burst 4, 4get 12/min burst 3), concurrency 2, failover degoog → 4get, exponential cooldown on 403/429 (1m to 15m), 1-hour LRU cache, results trimmed to 6 × (title, url, 220-char snippet).
- [x] `searchq` MCP server for Claude Code (user scope) and Codex (`tool_timeout_sec = 300`). It retries `queue_full` and gateway restarts itself, so the agent never sees a false failure.
- [x] Built-in `WebSearch` denied in `~/.claude/settings.json`; `MCP_TOOL_TIMEOUT=300000` so queued calls are not cut off.
- [x] `searchq` CLI on PATH (`~/.local/bin/searchq`) for shells and scripts.
- [x] Verified: 15 parallel queries, 15 succeeded, spread over 28s across both engines; degoog stopped, so traffic failed over to 4get; MCP stdio call returns compact results.

## Phase 3: Rules in CLAUDE.md and AGENTS.md
- [x] `config/agent-rules.md` is the single source. Installed into `~/.claude/CLAUDE.md` (new) and appended to `~/.codex/AGENTS.md`, between `leancontext:start/end` markers.
- Rule: wait for the queue; only `SEARCH_FAILED` / `SEARCH_UNAVAILABLE` / `SEARCH_TIMEOUT` mean failure.

## Phase 4: Command output compression (RTK)
- [x] `brew install rtk` (1.1.0).
- [~] Install the hooks yourself (Claude Code blocked me from installing a hook that rewrites its own commands):
  ```
  rtk init -g --hook-only --auto-patch
  rtk init -g --codex --hook-only --auto-patch
  ```
  Undo with `rtk init -g --uninstall`. Check savings with `rtk gain`.

## Phase 5: Standardized handoff
- [x] `~/.claude/skills/handoff`: `/handoff` writes a 40-line `HANDOFF.md` in a fixed shape; start the next session from it instead of carrying a long context.

## Phase 6: Trim always-loaded context (needs your decisions, see STRATEGY.md)
- [ ] Clean `~/.codex/AGENTS.md`: it is ~5.7 KB of stale claude-mem output from the Osteodata project, loaded into every Codex session.
- [ ] Disable plugins you don't use in a given project (8 enabled, several bring MCP servers whose tool lists load every session).
- [ ] Decide on claude-mem's SessionStart injection and superpowers' ~8.6 KB using-superpowers injection.

## Phase 7: RAG over your own docs
- [ ] Only after measuring Phases 1–6. claude-mem already provides a searchable memory corpus; add a code/doc index only if search-then-read still shows up as a big cost.

## Phase 8: Measure
- [ ] Baseline: one week of normal work, record `/usage` (or the Usage page) daily and `rtk gain`.
- [ ] Compare with the same kind of week after Phases 1–6. Watch for accuracy loss (more retries, wrong answers), not just tokens.
