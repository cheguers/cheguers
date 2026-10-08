import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hashEmbedText, makeHashEmbedder } from "../src/embedding/hash.js";
import { makeOpenAiEmbedder } from "../src/embedding/openai.js";
import { EmbeddingError } from "../src/errors.js";

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  a.reduce((sum, value, i) => sum + value * b[i]!, 0);

describe("hash embedder", () => {
  it("is deterministic, unit-length and has the configured dimensions", async () => {
    const embedder = makeHashEmbedder(64);
    const [a, b] = await Effect.runPromise(embedder.embed(["Hello world", "Hello world"]));
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    expect(cosine(a!, a!)).toBeCloseTo(1, 6);
    expect(embedder.id).toBe("hash-64");
  });

  it("ranks lexically closer texts higher", () => {
    const query = hashEmbedText("postgres migration downtime", 256);
    const near = hashEmbedText("zero downtime migration from mysql to postgres", 256);
    const far = hashEmbedText("bake sourdough bread at home", 256);
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it("returns a zero vector for text without tokens", () => {
    expect(hashEmbedText("  !!  ", 16).every((value) => value === 0)).toBe(true);
  });
});

interface FakeEmbeddingServer {
  readonly url: string;
  readonly requests: Array<string>;
  readonly close: () => Promise<void>;
}

let server: FakeEmbeddingServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Real HTTP server speaking the OpenAI embeddings contract (no module mocking). */
const startServer = (
  respond: (body: string, res: ServerResponse) => void,
): Promise<FakeEmbeddingServer> =>
  new Promise((resolve) => {
    const requests: Array<string> = [];
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        requests.push(body);
        respond(body, res);
      });
    });
    http.listen(0, "127.0.0.1", () => {
      // SAFETY: listen() on a TCP port always reports an AddressInfo, never a pipe name.
      const { port } = http.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => http.close(() => done())),
      });
    });
  });

const reversedRows = (body: string, dims: number): string => {
  const input: ReadonlyArray<string> = JSON.parse(body).input;
  const data = input.map((text, index) => ({
    index,
    embedding: Array.from({ length: dims }, (_, d) => text.length + d),
  }));
  return JSON.stringify({ data: data.reverse() });
};

describe("openai-compatible embedder", () => {
  it("batches requests and restores row order by index", async () => {
    server = await startServer((body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reversedRows(body, 3));
    });
    const embedder = makeOpenAiEmbedder({
      baseUrl: server.url,
      apiKey: "test-key",
      model: "test-model",
      dimensions: 3,
      batchSize: 2,
    });
    const rows = await Effect.runPromise(embedder.embed(["a", "bb", "ccc"]));
    expect(rows).toEqual([
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ]);
    expect(server.requests).toHaveLength(2);
    expect(JSON.parse(server.requests[0]!).model).toBe("test-model");
  });

  it("fails with EmbeddingError on HTTP errors and dimension mismatches", async () => {
    server = await startServer((body, res) => {
      if (body.includes("boom")) {
        res.writeHead(500);
        res.end("upstream exploded");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reversedRows(body, 5));
    });
    const embedder = makeOpenAiEmbedder({
      baseUrl: server.url,
      apiKey: undefined,
      model: "m",
      dimensions: 3,
      batchSize: 8,
    });
    const httpError = await Effect.runPromise(Effect.flip(embedder.embed(["boom"])));
    expect(httpError).toBeInstanceOf(EmbeddingError);
    expect(httpError.message).toContain("HTTP 500");
    const dimsError = await Effect.runPromise(Effect.flip(embedder.embed(["ok"])));
    expect(dimsError.message).toContain("3 dimensions");
  });
});
