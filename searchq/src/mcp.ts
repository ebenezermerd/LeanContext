// searchq MCP server: a thin stdio client of the gateway.
// It never fails fast: queue_full and gateway restarts are retried until SEARCHQ_MAX_WAIT_S,
// so the agent sees one slow answer instead of a false "search failed".
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GATEWAY = process.env.SEARCHQ_URL ?? "http://127.0.0.1:8787";
const MAX_WAIT_MS = Number(process.env.SEARCHQ_MAX_WAIT_S ?? 240) * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(q: string, max: number): Promise<{ text: string; isError: boolean }> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(`${GATEWAY}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, max }),
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1000)),
      });
      const body: any = await res.json();
      if (res.status === 503) {
        await sleep(Number(body.retryAfterS ?? 5) * 1000);
      } else if (res.ok) {
        return { text: format(body), isError: false };
      } else {
        return { text: `SEARCH_FAILED (not a queue delay): ${JSON.stringify(body)}`, isError: true };
      }
    } catch (e) {
      // Gateway down or restarting: back off and keep waiting until the deadline.
      if (Date.now() + 2000 > deadline) {
        return { text: `SEARCH_UNAVAILABLE after ${attempt} attempts: ${(e as Error).message}. Is the stack up? (cd ~/Developer/LeanContext/stack && docker compose up -d)`, isError: true };
      }
      await sleep(Math.min(2000 * attempt, 10000));
    }
    if (Date.now() > deadline) return { text: "SEARCH_TIMEOUT: queue did not drain in time", isError: true };
  }
}

// Plain numbered lines are far cheaper than JSON in context.
function format(b: any): string {
  if (!b.results?.length) return `No results for "${b.query}".`;
  const head = `${b.results.length} results via ${b.backend}${b.cached ? " (cached)" : ""}${b.waitedMs > 1500 ? `, queued ${Math.round(b.waitedMs / 1000)}s` : ""}`;
  const lines = b.results.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
  return [head, ...lines].join("\n");
}

const server = new McpServer({ name: "searchq", version: "0.1.0" });

server.registerTool(
  "web_search",
  {
    description:
      "Search the web through the local rate-limited queue (degoog, falling back to 4get). " +
      "Calls are queued and may take up to a few minutes under load: a slow response is NOT a failure, wait for it. " +
      "Only SEARCH_FAILED / SEARCH_UNAVAILABLE / SEARCH_TIMEOUT mean the search really failed.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      max_results: z.number().int().min(1).max(20).optional().describe("Default 6; ask for more only if needed"),
    },
  },
  async ({ query, max_results }) => {
    const r = await search(query, max_results ?? 6);
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  },
);

await server.connect(new StdioServerTransport());
