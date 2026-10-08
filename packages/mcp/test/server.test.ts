import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@cheguers/core";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import type { BackendKind } from "../src/backend/types.js";
import type { ServerSettings } from "../src/config.js";
import { appLayer } from "../src/server.js";

interface JsonRpcReply {
  readonly id?: number;
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ readonly text: string }>;
    readonly protocolVersion?: string;
  };
  readonly error?: { readonly message: string };
}

const settingsFor = (backend: BackendKind, dir: string): ServerSettings => ({
  host: "127.0.0.1",
  port: 0,
  path: "/mcp",
  backend,
  dbPath: join(dir, "memory.db"),
  embedder: {
    provider: "hash",
    model: "hash",
    dimensions: 128,
    batchSize: 16,
    cacheDir: undefined,
    offline: true,
    baseUrl: "http://unused.invalid",
    apiKey: undefined,
  },
  telemetryDir: join(dir, "telemetry"),
  runId: `test-${backend}`,
});

/** Minimal Streamable-HTTP MCP client over the router's web handler. */
const makeClient = (settings: ServerSettings) => {
  const { handler, dispose } = HttpRouter.toWebHandler(appLayer(settings), { disableLogger: true });
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 1;

  const post = async (body: JsonObject): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    if (protocolVersion !== null) headers["mcp-protocol-version"] = protocolVersion;
    const response = await handler(
      new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
    );
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };

  const parse = async (response: Response): Promise<JsonRpcReply> => {
    const text = await response.text();
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      return JSON.parse(data[data.length - 1]!);
    }
    return JSON.parse(text);
  };

  const request = async (method: string, params: JsonObject): Promise<JsonRpcReply> =>
    parse(await post({ jsonrpc: "2.0", id: nextId++, method, params }));

  const callTool = async (name: string, args: JsonObject) => {
    const reply = await request("tools/call", { name, arguments: args });
    expect(reply.error).toBeUndefined();
    const result = reply.result!;
    const text = result.content?.[0]?.text ?? "null";
    // Tool errors carry the plain error message; successes carry JSON.
    return result.isError === true
      ? { isError: true, data: undefined, message: text }
      : { isError: false, data: JSON.parse(text), message: undefined };
  };

  const initialize = async (): Promise<void> => {
    const reply = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    });
    protocolVersion = reply.result?.protocolVersion ?? "2025-06-18";
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(ack.status).toBe(202);
  };

  const health = () => handler(new Request("http://localhost/health"));

  return { initialize, request, callTool, health, dispose };
};

const TOOL_NAMES = [
  "memory_get",
  "memory_ingest",
  "memory_link",
  "memory_neighbors",
  "memory_search",
  "memory_stats",
  "memory_store",
];

describe("MCP server over Streamable HTTP", () => {
  for (const backend of ["cheguers", "notes"] as const) {
    it(`serves the memory toolkit end to end (${backend})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cheguers-mcp-server-"));
      const settings = settingsFor(backend, dir);
      const client = makeClient(settings);
      try {
        expect(await (await client.health()).text()).toBe("ok");
        await client.initialize();

        const listed = await client.request("tools/list", {});
        const tools = listed.result?.tools ?? [];
        expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
        expect(tools.every((tool) => (tool.description ?? "").length > 20)).toBe(true);

        const stored = await client.callTool("memory_store", {
          text: "Throughput must reach 5x baseline before sending VERSION v2.",
          title: "kv-live-surgery goal",
          labels: ["goal"],
        });
        expect(stored.isError).toBe(false);
        expect(stored.data.id).toMatch(/^rec_/);

        const ingested = await client.callTool("memory_ingest", {
          documents: [
            {
              path: "/app/README.md",
              content: "Server listens on port 9000.\nLiveness endpoint must answer within 1s.",
            },
          ],
        });
        expect(ingested.data.totalChunks).toBe(1);

        const found = await client.callTool("memory_search", { query: "throughput baseline v2" });
        expect(found.data.hits[0].id).toBe(stored.data.id);

        const got = await client.callTool("memory_get", { id: stored.data.id });
        expect(got.data.text).toContain("5x baseline");

        const linked = await client.callTool("memory_link", {
          sourceId: stored.data.id,
          targetId: ingested.data.documents[0].documentId,
          type: "ABOUT",
        });
        expect(linked.isError).toBe(false);

        const near = await client.callTool("memory_neighbors", { id: stored.data.id });
        expect(near.data.neighbors).toHaveLength(1);

        const stats = await client.callTool("memory_stats", {});
        expect(stats.data).toEqual({ notes: 1, documents: 1, chunks: 1, links: 2 });

        const missing = await client.callTool("memory_get", { id: "rec_nope_00000001" });
        expect(missing.isError).toBe(true);
        expect(missing.message).toBe("no memory item with id rec_nope_00000001");

        const invalid = await client.request("tools/call", {
          name: "memory_search",
          arguments: { query: "x", limit: 999 },
        });
        expect(invalid.error !== undefined || invalid.result?.isError === true).toBe(true);
      } finally {
        await client.dispose();
      }

      const lines = readFileSync(join(dir, "telemetry", `test-${backend}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[0].type).toBe("start");
      expect(lines[0].backend).toBe(backend);
      const calls = lines.filter((line) => line.type === "call");
      expect(calls.map((line) => line.tool)).toContain("memory_search");
      expect(calls.find((line) => line.tool === "memory_store").stats.notes).toBe(1);
      expect(calls.some((line) => line.ok === false && line.error.includes("no memory item"))).toBe(
        true,
      );
      const summary = lines[lines.length - 1];
      expect(summary.type).toBe("summary");
      expect(summary.tools.memory_search.calls).toBe(1);
      expect(summary.stats.documents).toBe(1);
    });
  }
});
