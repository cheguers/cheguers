import { Context, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { DEFAULT_LINK_TYPE, clampInteger } from "./backend/common.js";
import type { BackendStats, MemoryBackend } from "./backend/types.js";
import { MemoryError } from "./errors.js";
import type { Telemetry } from "./telemetry.js";

export class MemoryBackendService extends Context.Service<MemoryBackendService, MemoryBackend>()(
  "cheguers/mcp/MemoryBackend",
) {}

export class TelemetryService extends Context.Service<TelemetryService, Telemetry>()(
  "cheguers/mcp/Telemetry",
) {}

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_EXPAND_DEPTH = 1;
export const DEFAULT_NEIGHBOR_LIMIT = 25;
export const MAX_NEIGHBOR_LIMIT = 200;
export const DEFAULT_CHUNK_CHARS = 1500;

const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

const Labels = Schema.Array(Schema.String);
const MetadataValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);

const ItemSummaryFields = {
  id: Schema.String,
  kind: Schema.Literals(["note", "document", "chunk"]),
  title: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  lines: Schema.optional(Schema.String),
  labels: Labels,
  snippet: Schema.String,
};

export const MemoryStore = Tool.make("memory_store", {
  description:
    "Save a note to your persistent memory for this task: facts you discovered, decisions, " +
    "constraints, intermediate results, plans, or anything you may need again later. " +
    "Returns the note id. Optionally link it to existing memory items (by id) so related " +
    "knowledge stays connected.",
  parameters: Schema.Struct({
    text: Schema.String.annotate({ description: "The content to remember." }),
    title: Schema.optional(Schema.String).annotate({ description: "Short title." }),
    labels: Schema.optional(Labels).annotate({
      description: "Free-form tags used to filter searches, e.g. ['decision', 'schema'].",
    }),
    metadata: Schema.optional(Schema.Record(Schema.String, MetadataValueSchema)).annotate({
      description: "Optional flat key/value attributes.",
    }),
    links: Schema.optional(
      Schema.Array(
        Schema.Struct({
          targetId: Schema.String,
          type: Schema.optional(Schema.String),
        }),
      ),
    ).annotate({
      description: `Existing item ids this note relates to; type defaults to ${DEFAULT_LINK_TYPE}.`,
    }),
  }),
  success: Schema.Struct({ id: Schema.String, labels: Labels, links: Schema.Number }),
  failure: MemoryError,
});

export const MemoryIngest = Tool.make("memory_ingest", {
  description:
    "Index documents (files, logs, specs, data dumps) into memory so they can be searched " +
    "later. Send the file contents yourself: the memory server cannot read your filesystem. " +
    "Each document is split into line-aligned chunks; re-ingesting the same path replaces " +
    "the previous version.",
  parameters: Schema.Struct({
    documents: Schema.Array(
      Schema.Struct({
        path: Schema.String.annotate({ description: "Path or name identifying the document." }),
        content: Schema.String.annotate({ description: "Full text content." }),
        labels: Schema.optional(Labels),
      }),
    ),
    maxChunkChars: Schema.optional(intBetween(200, 8000)).annotate({
      description: `Approximate chunk size in characters (default ${DEFAULT_CHUNK_CHARS}).`,
    }),
  }),
  success: Schema.Struct({
    documents: Schema.Array(
      Schema.Struct({ path: Schema.String, documentId: Schema.String, chunks: Schema.Number }),
    ),
    totalChunks: Schema.Number,
  }),
  failure: MemoryError,
});

export const MemorySearch = Tool.make("memory_search", {
  description:
    "Search your memory (saved notes and ingested document chunks) with a natural-language " +
    "query. Returns the most relevant items with a snippet, path and line range; use " +
    "memory_get for full text.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(intBetween(1, MAX_SEARCH_LIMIT)).annotate({
      description: `Maximum results (default ${DEFAULT_SEARCH_LIMIT}).`,
    }),
    labels: Schema.optional(Labels).annotate({
      description: "Only consider items carrying all of these labels.",
    }),
    expandDepth: Schema.optional(intBetween(0, 3)).annotate({
      description: `How far to follow links around the best matches (default ${DEFAULT_EXPAND_DEPTH}).`,
    }),
  }),
  success: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({ ...ItemSummaryFields, score: Schema.Number, via: Schema.String }),
    ),
  }),
  failure: MemoryError,
});

export const MemoryGet = Tool.make("memory_get", {
  description: "Fetch the full text and metadata of one memory item by id.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({
    ...ItemSummaryFields,
    text: Schema.String,
    metadata: Schema.Record(Schema.String, MetadataValueSchema),
    createdAt: Schema.String,
  }),
  failure: MemoryError,
});

export const MemoryLink = Tool.make("memory_link", {
  description:
    "Create a typed, directed link between two memory items (e.g. a note DEPENDS_ON another, " +
    "or a note EXPLAINS a document chunk).",
  parameters: Schema.Struct({
    sourceId: Schema.String,
    targetId: Schema.String,
    type: Schema.optional(Schema.String).annotate({
      description: `Relationship type (default ${DEFAULT_LINK_TYPE}).`,
    }),
  }),
  success: Schema.Struct({ id: Schema.String }),
  failure: MemoryError,
});

export const MemoryNeighbors = Tool.make("memory_neighbors", {
  description:
    "List items linked to a memory item, up to 3 hops away. Document chunks are linked to " +
    "their document (HAS_CHUNK) and to the following chunk (NEXT_CHUNK), so this also " +
    "reads surrounding context of a search hit.",
  parameters: Schema.Struct({
    id: Schema.String,
    depth: Schema.optional(intBetween(1, 3)).annotate({ description: "Hops (default 1)." }),
    direction: Schema.optional(Schema.Literals(["outgoing", "incoming", "both"])).annotate({
      description: "Link direction to follow (default both).",
    }),
    types: Schema.optional(Labels).annotate({ description: "Only follow these link types." }),
    limit: Schema.optional(intBetween(1, MAX_NEIGHBOR_LIMIT)).annotate({
      description: `Maximum items (default ${DEFAULT_NEIGHBOR_LIMIT}).`,
    }),
  }),
  success: Schema.Struct({
    neighbors: Schema.Array(
      Schema.Struct({
        ...ItemSummaryFields,
        depth: Schema.Number,
        route: Schema.optional(Schema.String),
      }),
    ),
  }),
  failure: MemoryError,
});

export const MemoryStats = Tool.make("memory_stats", {
  description: "Count what is currently stored in memory.",
  success: Schema.Struct({
    notes: Schema.Number,
    documents: Schema.Number,
    chunks: Schema.Number,
    links: Schema.Number,
  }),
  failure: MemoryError,
});

export const MemoryToolkit = Toolkit.make(
  MemoryStore,
  MemoryIngest,
  MemorySearch,
  MemoryGet,
  MemoryLink,
  MemoryNeighbors,
  MemoryStats,
);

/**
 * Tool results travel as MCP `structuredContent`, which must be plain JSON:
 * drop keys whose value is `undefined` (optional fields left unset).
 */
const toJsonResult = <A>(value: A): A => JSON.parse(JSON.stringify(value));

/** Times a tool call and records it; write tools also snapshot storage stats. */
const instrument = <A>(
  telemetry: Telemetry,
  backend: MemoryBackend,
  tool: string,
  effect: Effect.Effect<A, MemoryError>,
  countResults: (value: A) => number,
  snapshotStats: boolean,
): Effect.Effect<A, MemoryError> =>
  Effect.suspend(() => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.map(toJsonResult),
      Effect.tap((value) =>
        Effect.gen(function* () {
          const latencyMs = performance.now() - startedAt;
          let stats: BackendStats | undefined;
          if (snapshotStats) {
            stats = yield* backend.stats.pipe(Effect.orElseSucceed(() => undefined));
          }
          yield* telemetry.record({
            tool,
            ok: true,
            latencyMs,
            results: countResults(value),
            error: undefined,
            stats,
          });
        }),
      ),
      Effect.tapError((error) =>
        telemetry.record({
          tool,
          ok: false,
          latencyMs: performance.now() - startedAt,
          results: 0,
          error: error.message,
          stats: undefined,
        }),
      ),
    );
  });

export const MemoryToolkitHandlers = MemoryToolkit.toLayer(
  Effect.gen(function* () {
    const backend = yield* MemoryBackendService;
    const telemetry = yield* TelemetryService;
    const run = <A>(
      tool: string,
      effect: Effect.Effect<A, MemoryError>,
      countResults: (value: A) => number,
      snapshotStats = false,
    ) => instrument(telemetry, backend, tool, effect, countResults, snapshotStats);

    return {
      memory_store: (params) =>
        run(
          "memory_store",
          backend.store({
            text: params.text,
            title: params.title,
            labels: params.labels ?? [],
            metadata: params.metadata ?? {},
            links: (params.links ?? []).map((link) => ({
              targetId: link.targetId,
              type: link.type ?? DEFAULT_LINK_TYPE,
            })),
          }),
          () => 1,
          true,
        ),
      memory_ingest: (params) =>
        run(
          "memory_ingest",
          backend.ingest({
            documents: params.documents.map((document) => ({
              path: document.path,
              content: document.content,
              labels: document.labels ?? [],
            })),
            maxChunkChars: params.maxChunkChars ?? DEFAULT_CHUNK_CHARS,
          }),
          (result) => result.totalChunks,
          true,
        ),
      memory_search: (params) =>
        run(
          "memory_search",
          backend.search({
            query: params.query,
            limit: clampInteger(params.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
            labels: params.labels ?? [],
            expandDepth: clampInteger(params.expandDepth ?? DEFAULT_EXPAND_DEPTH, 0, 3),
          }),
          (result) => result.hits.length,
        ),
      memory_get: (params) => run("memory_get", backend.get(params.id), () => 1),
      memory_link: (params) =>
        run(
          "memory_link",
          backend.link({
            sourceId: params.sourceId,
            targetId: params.targetId,
            type: params.type ?? DEFAULT_LINK_TYPE,
          }),
          () => 1,
          true,
        ),
      memory_neighbors: (params) =>
        run(
          "memory_neighbors",
          backend.neighbors({
            id: params.id,
            depth: clampInteger(params.depth ?? 1, 1, 3),
            direction: params.direction ?? "both",
            types: params.types ?? [],
            limit: clampInteger(params.limit ?? DEFAULT_NEIGHBOR_LIMIT, 1, MAX_NEIGHBOR_LIMIT),
          }),
          (result) => result.neighbors.length,
        ),
      memory_stats: () =>
        run(
          "memory_stats",
          backend.stats.pipe(
            Effect.map((stats) => ({
              notes: stats.notes,
              documents: stats.documents,
              chunks: stats.chunks,
              links: stats.links,
            })),
          ),
          () => 1,
        ),
    };
  }),
);
