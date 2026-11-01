# Context footprint strategy (tailored to this Mac, 2026-11-02)

Tokens are spent in three places. Fix them in order of size.

## 1. Context loaded on every turn (the biggest, and invisible)
Everything below is re-sent with each request in a session, so a few KB here multiplies by every turn.

| Source | Size | Recommendation |
|---|---|---|
| `~/.codex/AGENTS.md` | ~5.7 KB, stale claude-mem dump from Osteodata | Replace with just the LeanContext rules (backup in `config/backups/`). |
| superpowers `using-superpowers` SessionStart injection | ~8.6 KB | Keep only if you actually use its workflows; otherwise disable the plugin per project. |
| claude-mem SessionStart index | ~50 observations per project | Keep (it replaces re-exploration), but cap the observation count in its settings if it grows. |
| MCP tool definitions | 8 plugins enabled; design, vercel, cloudflare bring servers that mostly need auth you haven't given | Disable plugins you don't use in a project (`/plugin`), or turn them off per project in `.claude/settings.json` `enabledPlugins`. |
| `~/.claude/CLAUDE.md` | 1.2 KB (new) | Keep short. Every line you add costs on every turn. |

## 2. Tool output pulled into context
- Command output: RTK hook (Phase 4) compresses git, test, build and ls output before Claude sees it.
- Search: searchq returns ~6 short results as plain lines instead of a page of JSON, and caches repeats.
- Files: read by range, `rg` before reading, and never re-read after an edit.
- JSON and logs: pipe through `jq` / `head` / `rg` first.

## 3. Session length
- Cost grows with conversation length. Finish a task, `/handoff`, start fresh.
- Use subagents for broad searches so only their conclusion enters the main context.
- `opusplan`: Opus for the plan, Sonnet for execution.

## What not to cut
- Don't drop reading the code you're about to change, verification runs, or plan mode on multi-step work. Those prevent the retries that cost more than they save.
