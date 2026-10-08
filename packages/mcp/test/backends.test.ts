import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeCheguersBackend } from "../src/backend/cheguers.js";
import { makeNotesBackend } from "../src/backend/notes.js";
import type { BackendKind, MemoryBackend, SearchInput, StoreInput } from "../src/backend/types.js";
import { makeHashEmbedder } from "../src/embedding/hash.js";
import { MemoryError } from "../src/errors.js";

let open: MemoryBackend | undefined;

afterEach(async () => {
  if (open !== undefined) await Effect.runPromise(open.close);
  open = undefined;
});

const makeBackend = async (kind: BackendKind): Promise<MemoryBackend> => {
  if (kind === "notes") {
    open = makeNotesBackend();
    return open;
  }
  const dir = mkdtempSync(join(tmpdir(), "cheguers-mcp-"));
  open = await Effect.runPromise(
    makeCheguersBackend({
      dbPath: join(dir, "memory.db"),
      embedder: makeHashEmbedder(128),
      retrieval: kind === "cheguers" ? "hybrid" : "vector",
    }),
  );
  return open;
};

const note = (text: string, extra: Partial<StoreInput> = {}): StoreInput => ({
  text,
  title: undefined,
  labels: [],
  metadata: {},
  links: [],
  ...extra,
});

const query = (text: string, extra: Partial<SearchInput> = {}): SearchInput => ({
  query: text,
  limit: 5,
  labels: [],
  expandDepth: 1,
  ...extra,
});

const run = <A>(effect: Effect.Effect<A, MemoryError>): Promise<A> => Effect.runPromise(effect);
const fail = <A>(effect: Effect.Effect<A, MemoryError>): Promise<MemoryError> =>
  Effect.runPromise(Effect.flip(effect));

const SPEC = [
  "# Railway reporting rules",
  "Every operational point must declare latitude and longitude.",
  "Cross-border points are shared between two member states.",
  "",
  "## Voltage",
  "Qualifying sections have a traction power system of at least 15 kV.",
  "High-speed vehicles are counted separately from regular vehicles.",
].join("\n");

const KINDS: ReadonlyArray<BackendKind> = ["cheguers", "vector-only", "notes"];

for (const kind of KINDS) {
  describe(`memory backend contract: ${kind}`, () => {
    it("stores a note and finds it again by meaning-bearing words", async () => {
      const backend = await makeBackend(kind);
      const stored = await run(
        backend.store(
          note("The MySQL to Postgres cutover must keep p95 latency within 10ms.", {
            title: "Cutover constraint",
            labels: ["decision"],
            metadata: { priority: 1, confirmed: true },
          }),
        ),
      );
      await run(backend.store(note("Sourdough needs a long cold proof.")));
      expect(stored.labels).toEqual(["decision"]);

      const { hits } = await run(backend.search(query("postgres cutover latency")));
      expect(hits[0]!.id).toBe(stored.id);
      expect(hits[0]!.title).toBe("Cutover constraint");
      expect(hits[0]!.kind).toBe("note");

      const item = await run(backend.get(stored.id));
      expect(item.text).toContain("p95 latency");
      expect(item.metadata).toEqual({ priority: 1, confirmed: true });
    });

    it("filters search by labels", async () => {
      const backend = await makeBackend(kind);
      await run(backend.store(note("vehicle authorization counts per section", { labels: ["a"] })));
      const tagged = await run(
        backend.store(note("vehicle authorization counts per line", { labels: ["b"] })),
      );
      const { hits } = await run(backend.search(query("vehicle authorization", { labels: ["b"] })));
      expect(hits.map((hit) => hit.id)).toEqual([tagged.id]);
    });

    it("ingests documents into chunks linked to their document and neighbours", async () => {
      const backend = await makeBackend(kind);
      const result = await run(
        backend.ingest({
          documents: [{ path: "/app/docs/rules.md", content: SPEC, labels: ["spec"] }],
          maxChunkChars: 200,
        }),
      );
      expect(result.documents).toHaveLength(1);
      expect(result.totalChunks).toBeGreaterThan(1);

      const { hits } = await run(backend.search(query("traction power 15 kV qualifying")));
      const top = hits[0]!;
      expect(top.kind).toBe("chunk");
      expect(top.path).toBe("/app/docs/rules.md");
      expect(top.lines).toMatch(/^\d+-\d+$/);
      expect(top.labels).toEqual(["spec"]);
      expect(hits.every((hit) => hit.kind !== "document")).toBe(true);

      const { neighbors } = await run(
        backend.neighbors({ id: top.id, depth: 1, direction: "both", types: [], limit: 10 }),
      );
      expect(neighbors.some((n) => n.kind === "document" && n.route === "HAS_CHUNK")).toBe(true);

      const stats = await run(backend.stats);
      expect(stats.documents).toBe(1);
      expect(stats.chunks).toBe(result.totalChunks);
    });

    it("replaces a document when the same path is ingested again", async () => {
      const backend = await makeBackend(kind);
      const input = (content: string) => ({
        documents: [{ path: "notes.txt", content, labels: [] }],
        maxChunkChars: 500,
      });
      await run(backend.ingest(input("first version mentions zebra")));
      await run(backend.ingest(input("second version mentions giraffe")));
      const stats = await run(backend.stats);
      expect(stats.documents).toBe(1);
      expect(stats.chunks).toBe(1);
      const { hits } = await run(backend.search(query("giraffe")));
      expect(hits[0]!.snippet).toContain("second version");
    });

    it("links items and walks links up to the requested depth", async () => {
      const backend = await makeBackend(kind);
      const a = await run(backend.store(note("root cause: compaction drops tombstones")));
      const b = await run(
        backend.store(
          note("fix: retain tombstones until snapshot release", {
            links: [{ targetId: a.id, type: "FIXES" }],
          }),
        ),
      );
      const c = await run(backend.store(note("regression test added for tombstones")));
      await run(backend.link({ sourceId: c.id, targetId: b.id, type: "TESTS" }));

      const one = await run(
        backend.neighbors({ id: c.id, depth: 1, direction: "outgoing", types: [], limit: 10 }),
      );
      expect(one.neighbors.map((n) => n.id)).toEqual([b.id]);
      const two = await run(
        backend.neighbors({ id: c.id, depth: 2, direction: "outgoing", types: [], limit: 10 }),
      );
      expect(two.neighbors.map((n) => [n.id, n.depth, n.route])).toEqual([
        [b.id, 1, "TESTS"],
        [a.id, 2, "TESTS > FIXES"],
      ]);
      const typed = await run(
        backend.neighbors({
          id: c.id,
          depth: 2,
          direction: "outgoing",
          types: ["FIXES"],
          limit: 10,
        }),
      );
      expect(typed.neighbors).toEqual([]);
    });

    it("reports actionable errors", async () => {
      const backend = await makeBackend(kind);
      expect((await fail(backend.get("rec_doesnotexist01"))).message).toContain(
        "no memory item with id",
      );
      expect((await fail(backend.store(note("   ")))).message).toBe("text must not be empty");
      expect((await fail(backend.store(note("x", { labels: ["bad label"] })))).message).toContain(
        "invalid label",
      );
      expect((await fail(backend.store(note("x", { labels: ["memory"] })))).message).toContain(
        "reserved",
      );
      const missing = await fail(
        backend.store(note("x", { links: [{ targetId: "rec_missing_000001", type: "RELATED" }] })),
      );
      expect(missing).toBeInstanceOf(MemoryError);
      expect(missing.message).toContain("rec_missing_000001");
      expect((await run(backend.stats)).notes).toBe(0);
    });
  });
}

describe("cheguers hybrid retrieval", () => {
  it("surfaces graph neighbours of a vector seed with provenance", async () => {
    const backend = await makeBackend("cheguers");
    const seed = await run(
      backend.store(note("kv server throughput regression after lock change")),
    );
    const linked = await run(
      backend.store(
        note("rollout checklist for v2 binary", {
          links: [{ targetId: seed.id, type: "FOLLOWS" }],
        }),
      ),
    );
    const { hits } = await run(
      backend.search(query("kv server throughput regression", { limit: 5 })),
    );
    expect(hits[0]!.id).toBe(seed.id);
    expect(hits[0]!.via).toBe("vector");
    const viaGraph = hits.find((hit) => hit.id === linked.id);
    expect(viaGraph).toBeDefined();

    const labeled = await run(
      backend.store(note("kv server throughput notes", { labels: ["perf"] })),
    );
    const filtered = await run(
      backend.search(query("kv server throughput regression", { labels: ["perf"] })),
    );
    expect(filtered.hits.map((hit) => hit.id)).toEqual([labeled.id]);

    const vectorOnly = await run(
      backend.search(query("kv server throughput regression", { expandDepth: 0 })),
    );
    expect(vectorOnly.hits.every((hit) => hit.via === "vector")).toBe(true);
  });

  it("persists memory across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cheguers-mcp-reopen-"));
    const config = {
      dbPath: join(dir, "memory.db"),
      embedder: makeHashEmbedder(64),
      retrieval: "hybrid" as const,
    };
    const first = await Effect.runPromise(makeCheguersBackend(config));
    const stored = await run(first.store(note("durable fact about wal segments")));
    await Effect.runPromise(first.close);
    open = await Effect.runPromise(makeCheguersBackend(config));
    expect((await run(open.stats)).notes).toBe(1);
    expect((await run(open.get(stored.id))).text).toBe("durable fact about wal segments");
    expect((await run(open.stats)).storageBytes).toBeGreaterThan(0);
  });
});
