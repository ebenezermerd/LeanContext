// searchq gateway: one shared FIFO queue + per-backend rate limiting for every agent on this machine.
// All search traffic (Claude Code MCP, Codex, the CLI) goes through here, so concurrent agents
// can never burst the upstream engines and get us blocked.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Result = { title: string; url: string; snippet: string };
type Job = {
  q: string;
  max: number;
  enqueuedAt: number;
  resolve: (r: Answer) => void;
};
type Answer = { status: number; body: Record<string, unknown> };

const env = (k: string, d: number) => Number(process.env[k] ?? d);

const PORT = env("SEARCHQ_PORT", 8787);
const MAX_QUEUE = env("SEARCHQ_MAX_QUEUE", 100);
const CONCURRENCY = env("SEARCHQ_CONCURRENCY", 2);
const CACHE_TTL_MS = env("SEARCHQ_CACHE_TTL_S", 3600) * 1000;
const CACHE_MAX = env("SEARCHQ_CACHE_MAX", 500);
const SNIPPET_CHARS = env("SEARCHQ_SNIPPET_CHARS", 220);
const UPSTREAM_TIMEOUT_MS = env("SEARCHQ_UPSTREAM_TIMEOUT_S", 20) * 1000;

// Token bucket per backend. `ratePerMin` is the sustained rate, `burst` the bucket size.
class Bucket {
  private tokens: number;
  private last = Date.now();
  private ratePerMin: number;
  private burst: number;
  constructor(ratePerMin: number, burst: number) {
    this.ratePerMin = ratePerMin;
    this.burst = burst;
    this.tokens = burst;
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60000) * this.ratePerMin);
    this.last = now;
  }
  // Milliseconds until a token is available (0 means one was taken).
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.ratePerMin) * 60000);
  }
}

type Backend = {
  name: string;
  bucket: Bucket;
  cooldownUntil: number;
  failures: number;
  ok: number;
  search: (q: string) => Promise<Result[]>;
};

class UpstreamError extends Error {
  readonly blocked: boolean;
  constructor(msg: string, blocked: boolean) {
    super(msg);
    this.blocked = blocked;
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (res.status === 429 || res.status === 403) throw new UpstreamError(`HTTP ${res.status}`, true);
  if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, false);
  return res.json();
}

const DEGOOG_URL = process.env.DEGOOG_URL ?? "http://127.0.0.1:4444";
const FOURGET_URL = process.env.FOURGET_URL ?? "http://127.0.0.1:8088";

const backends: Backend[] = [
  {
    name: "degoog",
    bucket: new Bucket(env("DEGOOG_RATE_PER_MIN", 20), env("DEGOOG_BURST", 4)),
    cooldownUntil: 0,
    failures: 0,
    ok: 0,
    async search(q) {
      const j = await getJson(`${DEGOOG_URL}/api/search?q=${encodeURIComponent(q)}`);
      return (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet ?? "" }));
    },
  },
  {
    name: "4get",
    bucket: new Bucket(env("FOURGET_RATE_PER_MIN", 12), env("FOURGET_BURST", 3)),
    cooldownUntil: 0,
    failures: 0,
    ok: 0,
    async search(q) {
      const j = await getJson(`${FOURGET_URL}/api/v1/web?s=${encodeURIComponent(q)}`);
      if (j.status && j.status !== "ok") throw new UpstreamError(String(j.status), /block|captcha|rate/i.test(j.status));
      return (j.web ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
    },
  },
];

const cache = new Map<string, { at: number; results: Result[]; backend: string }>();
const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

function cacheGet(key: string) {
  const hit = cache.get(key);
  if (!hit) return;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return;
  }
  // Re-insert to keep Map order as LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}
function cacheSet(key: string, results: Result[], backend: string) {
  cache.set(key, { at: Date.now(), results, backend });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

// Shrinks results to what an agent actually needs: dedupe by URL, cap count, trim snippets.
function compact(results: Result[], max: number): Result[] {
  const seen = new Set<string>();
  const out: Result[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const s = r.snippet.replace(/\s+/g, " ").trim();
    out.push({ title: r.title.trim(), url: r.url, snippet: s.length > SNIPPET_CHARS ? s.slice(0, SNIPPET_CHARS - 1) + "…" : s });
    if (out.length >= max) break;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Picks the healthy backend whose bucket frees up first, waiting for it if needed.
// Order in `backends` is the preference order when both are ready.
async function acquire(exclude: Set<string>): Promise<Backend | undefined> {
  for (;;) {
    const now = Date.now();
    const live = backends.filter((b) => !exclude.has(b.name) && b.cooldownUntil <= now);
    if (live.length === 0) {
      const cooling = backends.filter((b) => !exclude.has(b.name));
      if (cooling.length === 0) return;
      const soonest = Math.min(...cooling.map((b) => b.cooldownUntil));
      // Don't hold a job forever behind a long cooldown; let it fail clearly instead.
      if (soonest - now > 30000) return;
      await sleep(soonest - now);
      continue;
    }
    let bestWait = Infinity;
    for (const b of live) {
      const wait = b.bucket.take();
      if (wait === 0) return b;
      bestWait = Math.min(bestWait, wait);
    }
    await sleep(bestWait);
  }
}

function penalize(b: Backend, blocked: boolean) {
  b.failures += 1;
  // Blocks back off hard (1m, 2m, 4m … capped at 15m); plain errors briefly.
  const base = blocked ? 60000 * 2 ** Math.min(b.failures - 1, 4) : 5000;
  b.cooldownUntil = Date.now() + Math.min(base, 15 * 60000);
}

async function run(job: Job): Promise<Answer> {
  const key = norm(job.q);
  const waitedMs = Date.now() - job.enqueuedAt;
  const hit = cacheGet(key);
  if (hit) return { status: 200, body: { query: job.q, backend: hit.backend, cached: true, waitedMs, results: compact(hit.results, job.max) } };

  const tried = new Set<string>();
  const errors: string[] = [];
  for (;;) {
    const b = await acquire(tried);
    if (!b) break;
    tried.add(b.name);
    try {
      const results = await b.search(job.q);
      b.failures = 0;
      b.ok += 1;
      if (results.length === 0) {
        errors.push(`${b.name}: 0 results`);
        continue;
      }
      cacheSet(key, results, b.name);
      return { status: 200, body: { query: job.q, backend: b.name, cached: false, waitedMs: Date.now() - job.enqueuedAt, results: compact(results, job.max) } };
    } catch (e) {
      const blocked = e instanceof UpstreamError && e.blocked;
      penalize(b, blocked);
      errors.push(`${b.name}: ${(e as Error).message}`);
    }
  }
  // Every backend answered and none had results: that is a real empty result, not a failure.
  if (errors.every((m) => m.endsWith("0 results"))) {
    return { status: 200, body: { query: job.q, backend: "none", cached: false, waitedMs: Date.now() - job.enqueuedAt, results: [] } };
  }
  return { status: 502, body: { error: "all_backends_failed", detail: errors } };
}

const queue: Job[] = [];
let active = 0;

function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    run(job)
      .catch((e) => ({ status: 500, body: { error: String(e) } }))
      .then((a) => job.resolve(a))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function enqueue(q: string, max: number): Promise<Answer> | undefined {
  if (queue.length >= MAX_QUEUE) return;
  return new Promise((resolve) => {
    queue.push({ q, max, enqueuedAt: Date.now(), resolve });
    pump();
  });
}

function send(res: ServerResponse, a: Answer, headers: Record<string, string> = {}) {
  res.writeHead(a.status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(a.body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/health") {
      const now = Date.now();
      return send(res, {
        status: 200,
        body: {
          queued: queue.length,
          active,
          cached: cache.size,
          backends: backends.map((b) => ({ name: b.name, ok: b.ok, failures: b.failures, coolingForS: Math.max(0, Math.ceil((b.cooldownUntil - now) / 1000)) })),
        },
      });
    }
    if (url.pathname === "/search") {
      const body = req.method === "POST" ? await readBody(req) : {};
      const q = String(body.q ?? url.searchParams.get("q") ?? "").trim();
      const max = Math.min(Math.max(Number(body.max ?? url.searchParams.get("max") ?? 6), 1), 20);
      if (!q) return send(res, { status: 400, body: { error: "missing q" } });
      const pending = enqueue(q, max);
      // Queue full: tell the caller exactly when to come back instead of failing silently.
      if (!pending) return send(res, { status: 503, body: { error: "queue_full", retryAfterS: 5 } }, { "retry-after": "5" });
      return send(res, await pending);
    }
    send(res, { status: 404, body: { error: "not found" } });
  } catch (e) {
    send(res, { status: 500, body: { error: String(e) } });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`searchq gateway on :${PORT}`));
