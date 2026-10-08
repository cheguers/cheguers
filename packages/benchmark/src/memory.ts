/**
 * Memory-layer benchmark: the workload the MCP sidecar sees during a
 * Terminal-Bench trial (bulk document ingestion, then many searches).
 *
 *   tsx src/memory.ts [chunks=5000] [searches=100] [dimensions=384]
 *
 * Uses the deterministic hash embedder so timings isolate storage and
 * retrieval from model inference. Prints a JSON report like run.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  makeCheguersBackend,
  makeHashEmbedder,
  makeNotesBackend,
  type MemoryBackend,
} from "@cheguers/mcp";
import type { ScenarioResult } from "./report.js";

const percentiles = (
  values: ReadonlyArray<number>,
): Pick<ScenarioResult, "p50" | "p95" | "p99"> => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
};

const makeRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const VOCABULARY = Array.from({ length: 4000 }, (_, i) => `term${i.toString(36)}`);

const sentence = (random: () => number, words: number): string =>
  Array.from(
    { length: words },
    () => VOCABULARY[Math.floor(random() * random() * VOCABULARY.length)]!,
  ).join(" ");

interface Corpus {
  readonly documents: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly queries: ReadonlyArray<string>;
}

/** ~CHUNKS_PER_DOC chunks of ~CHUNK_CHARS characters per document. */
const CHUNK_CHARS = 1200;
const CHUNKS_PER_DOC = 20;

const makeCorpus = (chunks: number, searches: number): Corpus => {
  const random = makeRandom(42);
  const documents = [];
  const docCount = Math.max(1, Math.ceil(chunks / CHUNKS_PER_DOC));
  for (let d = 0; d < docCount; d++) {
    const lines: Array<string> = [];
    let size = 0;
    while (size < CHUNK_CHARS * CHUNKS_PER_DOC * 0.9) {
      const line = sentence(random, 8 + Math.floor(random() * 10));
      lines.push(line);
      size += line.length + 1;
    }
    documents.push({
      path: `/app/data/file_${String(d).padStart(5, "0")}.txt`,
      content: lines.join("\n"),
    });
  }
  const queries = Array.from({ length: searches }, () => sentence(random, 5));
  return { documents, queries };
};

const time = async (run: () => Promise<void>): Promise<number> => {
  const startedAt = performance.now();
  await run();
  return performance.now() - startedAt;
};

const measure = async (
  name: string,
  backend: MemoryBackend,
  corpus: Corpus,
  scenarios: Array<ScenarioResult>,
  searchModes: ReadonlyArray<{ readonly label: string; readonly expandDepth: number }>,
): Promise<number> => {
  const ingestMs: Array<number> = [];
  let chunks = 0;
  const ingestStartedAt = performance.now();
  for (const document of corpus.documents) {
    ingestMs.push(
      await time(async () => {
        const result = await Effect.runPromise(
          backend.ingest({
            documents: [{ ...document, labels: [] }],
            maxChunkChars: CHUNK_CHARS,
          }),
        );
        chunks += result.totalChunks;
      }),
    );
  }
  const ingestTotalMs = performance.now() - ingestStartedAt;
  scenarios.push({ name: `${name}.ingest_document`, unit: "ms", ...percentiles(ingestMs) });
  const throughput = (chunks / ingestTotalMs) * 1000;
  scenarios.push({
    name: `${name}.ingest_chunks_per_s`,
    unit: "ops/s",
    p50: throughput,
    p95: throughput,
    p99: throughput,
  });

  for (const mode of searchModes) {
    const latencies: Array<number> = [];
    for (const query of corpus.queries) {
      latencies.push(
        await time(async () => {
          await Effect.runPromise(
            backend.search({ query, limit: 8, labels: [], expandDepth: mode.expandDepth }),
          );
        }),
      );
    }
    scenarios.push({ name: `${name}.search_${mode.label}`, unit: "ms", ...percentiles(latencies) });
  }
  return chunks;
};

const main = async (): Promise<void> => {
  const targetChunks = Number(process.argv[2] ?? 5000);
  const searches = Number(process.argv[3] ?? 100);
  const dimensions = Number(process.argv[4] ?? 384);
  const corpus = makeCorpus(targetChunks, searches);
  const dir = mkdtempSync(join(tmpdir(), "cheguers-memory-bench-"));
  const scenarios: Array<ScenarioResult> = [];

  const cheguers = await Effect.runPromise(
    makeCheguersBackend({
      dbPath: join(dir, "memory.db"),
      embedder: makeHashEmbedder(dimensions),
      retrieval: "hybrid",
    }),
  );
  const chunks = await measure("cheguers", cheguers, corpus, scenarios, [
    { label: "vector", expandDepth: 0 },
    { label: "hybrid_depth1", expandDepth: 1 },
    { label: "hybrid_depth2", expandDepth: 2 },
  ]);
  const stats = await Effect.runPromise(cheguers.stats);
  await Effect.runPromise(cheguers.close);

  await measure("notes", makeNotesBackend(), corpus, scenarios, [
    { label: "keyword", expandDepth: 0 },
  ]);

  console.log(
    JSON.stringify(
      {
        environment: {
          nodeVersion: process.version,
          platform: `${process.platform}-${process.arch}`,
          datasetSeed: 42,
          documents: corpus.documents.length,
          chunks,
          searches,
          vectorDimensions: dimensions,
          embedder: `hash-${dimensions}`,
          dbSizeBytes: stats.storageBytes,
          rssBytes: process.memoryUsage().rss,
        },
        scenarios,
      },
      null,
      2,
    ),
  );
  rmSync(dir, { recursive: true, force: true });
};

main().catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
