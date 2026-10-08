import { existsSync, statSync } from "node:fs";
import { Effect } from "effect";
import {
  open,
  type CheguersDBHandle,
  type CheguersError,
  type CheguersRecord,
  type HybridQuery,
  type VectorSearchInput,
} from "@cheguers/core";
import { chunkText } from "../chunking.js";
import type { Embedder } from "../embedding/embedder.js";
import { MemoryError, type EmbeddingError } from "../errors.js";
import {
  HAS_CHUNK,
  KIND_LABELS,
  MEMORY_LABEL,
  NEXT_CHUNK,
  chunkData,
  chunkEmbeddingText,
  documentData,
  kindOf,
  memoryLabels,
  metadataOf,
  noteData,
  noteEmbeddingText,
  summarize,
  textOf,
  validateRelationType,
  validateText,
} from "./common.js";
import type {
  BackendStats,
  IngestInput,
  IngestedDocument,
  LinkInput,
  MemoryBackend,
  MemoryItem,
  NeighborsInput,
  SearchHit,
  SearchInput,
  StoreInput,
} from "./types.js";

/** Vector namespace holding note and chunk embeddings. */
export const MEMORY_NAMESPACE = "memory";

export interface CheguersBackendConfig {
  readonly dbPath: string;
  readonly embedder: Embedder;
  /** `hybrid` enables graph expansion in search; `vector` is the ablation arm. */
  readonly retrieval: "hybrid" | "vector";
}

const describeCheguersError = (error: CheguersError): string => {
  switch (error._tag) {
    case "NotFoundError":
      return error.detail;
    case "ValidationError":
    case "ConflictError":
      return error.message;
    case "DatabaseError":
    case "TransactionError":
      return `database failure during ${error.operation}`;
  }
};

const fromCheguers = (error: CheguersError): MemoryError =>
  new MemoryError({ message: describeCheguersError(error) });

/** Relationship failures name both endpoints so the agent can fix the call. */
const linkError =
  (sourceId: string, targetId: string) =>
  (error: CheguersError): MemoryError =>
    new MemoryError({
      message: `cannot link ${sourceId} -> ${targetId}: ${describeCheguersError(error)}`,
    });

const fromEmbedding = (error: EmbeddingError): MemoryError =>
  new MemoryError({ message: error.message });

/** Runs a synchronous validator that throws MemoryError. */
const validate = <A>(thunk: () => A): Effect.Effect<A, MemoryError> =>
  Effect.try({
    try: thunk,
    catch: (cause) =>
      cause instanceof MemoryError
        ? cause
        : new MemoryError({ message: cause instanceof Error ? cause.message : "invalid input" }),
  });

const fileBytes = (path: string): number => (existsSync(path) ? statSync(path).size : 0);

interface Counters {
  notes: number;
  documents: number;
  chunks: number;
  links: number;
  vectors: number;
}

const countLabel = (db: CheguersDBHandle, label: string) =>
  db.query.find({ labels: [MEMORY_LABEL, label] }).pipe(Effect.map((rows) => rows.length));

const toItem = (record: CheguersRecord): MemoryItem => ({
  ...summarize(record.id, record.data, record.labels),
  text: textOf(record.data),
  metadata: metadataOf(record.data),
  createdAt: record.createdAt,
});

export const makeCheguersBackend = (
  config: CheguersBackendConfig,
): Effect.Effect<MemoryBackend, MemoryError> =>
  Effect.gen(function* () {
    const db = yield* open(config.dbPath).pipe(Effect.mapError(fromCheguers));
    const embedder = config.embedder;
    const counters: Counters = {
      notes: yield* countLabel(db, KIND_LABELS.note).pipe(Effect.mapError(fromCheguers)),
      documents: yield* countLabel(db, KIND_LABELS.document).pipe(Effect.mapError(fromCheguers)),
      chunks: yield* countLabel(db, KIND_LABELS.chunk).pipe(Effect.mapError(fromCheguers)),
      // Links are counted from open: the core exposes no relationship count,
      // and each benchmark trial starts from an empty database anyway.
      links: 0,
      vectors: 0,
    };
    counters.vectors = counters.notes + counters.chunks;

    const embedOne = (text: string) =>
      embedder.embed([text]).pipe(
        Effect.mapError(fromEmbedding),
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row === undefined
            ? Effect.fail(new MemoryError({ message: "embedder returned no vector" }))
            : Effect.succeed(row);
        }),
      );

    const store = (input: StoreInput) =>
      Effect.gen(function* () {
        const text = yield* validate(() => validateText(input.text, "text"));
        const labels = yield* validate(() => memoryLabels("note", input.labels));
        const links = yield* validate(() =>
          input.links.map((link) => ({ ...link, type: validateRelationType(link.type) })),
        );
        for (const link of links) {
          yield* db.records
            .get(link.targetId)
            .pipe(Effect.mapError(linkError("the new note", link.targetId)));
        }
        const vector = yield* embedOne(noteEmbeddingText(input.title, text));
        const record = yield* db
          .transaction((ops) =>
            Effect.gen(function* () {
              const created = yield* ops.records.create({
                data: noteData(text, input.title, input.metadata),
                labels,
              });
              yield* ops.vectors.upsert({
                recordId: created.id,
                namespace: MEMORY_NAMESPACE,
                vector,
              });
              for (const link of links) {
                yield* ops.relationships.create({
                  type: link.type,
                  sourceId: created.id,
                  targetId: link.targetId,
                });
              }
              return created;
            }),
          )
          .pipe(Effect.mapError(fromCheguers));
        counters.notes++;
        counters.vectors++;
        counters.links += links.length;
        return {
          id: record.id,
          labels: summarize(record.id, record.data, labels).labels,
          links: links.length,
        };
      });

    /** Removes an earlier ingest of the same path so re-ingesting replaces it. */
    const dropDocument = (path: string) =>
      Effect.gen(function* () {
        const previous = yield* db.query.find({
          labels: [MEMORY_LABEL, KIND_LABELS.document],
          where: { property: "path", op: "eq", value: path },
        });
        for (const document of previous) {
          const edges = yield* db.relationships.outgoing(document.id, HAS_CHUNK);
          const chunkIds = edges.map((edge) => edge.targetId);
          yield* db.bulk.deleteRecords([document.id, ...chunkIds]);
          counters.documents--;
          counters.chunks -= chunkIds.length;
          counters.vectors -= chunkIds.length;
          // HAS_CHUNK + NEXT_CHUNK edges; agent links touching chunks are not tracked here.
          counters.links -= edges.length + Math.max(0, chunkIds.length - 1);
        }
      }).pipe(Effect.mapError(fromCheguers));

    const ingest = (input: IngestInput) =>
      Effect.gen(function* () {
        const results: Array<IngestedDocument> = [];
        let totalChunks = 0;
        for (const document of input.documents) {
          const path = yield* validate(() => validateText(document.path, "path"));
          const labels = yield* validate(() => memoryLabels("chunk", document.labels));
          const docLabels = yield* validate(() => memoryLabels("document", document.labels));
          const chunks = yield* validate(() =>
            chunkText(document.content, {
              maxChars: input.maxChunkChars,
              overlapChars: Math.floor(input.maxChunkChars / 8),
            }),
          );
          const vectors = yield* embedder
            .embed(chunks.map((chunk) => chunkEmbeddingText(path, chunk.text)))
            .pipe(Effect.mapError(fromEmbedding));
          yield* dropDocument(path);
          const documentId = yield* db
            .transaction((ops) =>
              Effect.gen(function* () {
                const doc = yield* ops.records.create({
                  data: documentData(path, chunks.length, document.content.length),
                  labels: docLabels,
                });
                let previousId: string | undefined;
                for (let i = 0; i < chunks.length; i++) {
                  const chunk = chunks[i]!;
                  const created = yield* ops.records.create({
                    data: chunkData(path, chunk.text, chunk.index, chunk.startLine, chunk.endLine),
                    labels,
                  });
                  yield* ops.vectors.upsert({
                    recordId: created.id,
                    namespace: MEMORY_NAMESPACE,
                    vector: vectors[i]!,
                  });
                  yield* ops.relationships.create({
                    type: HAS_CHUNK,
                    sourceId: doc.id,
                    targetId: created.id,
                  });
                  if (previousId !== undefined) {
                    yield* ops.relationships.create({
                      type: NEXT_CHUNK,
                      sourceId: previousId,
                      targetId: created.id,
                    });
                  }
                  previousId = created.id;
                }
                return doc.id;
              }),
            )
            .pipe(Effect.mapError(fromCheguers));
          counters.documents++;
          counters.chunks += chunks.length;
          counters.vectors += chunks.length;
          counters.links += chunks.length + Math.max(0, chunks.length - 1);
          totalChunks += chunks.length;
          results.push({ path, documentId, chunks: chunks.length });
        }
        return { documents: results, totalChunks };
      });

    const vectorSearch = (input: SearchInput, vector: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const base: VectorSearchInput = {
          namespace: MEMORY_NAMESPACE,
          vector,
          metric: "cosine",
          topK: input.limit,
        };
        const query: VectorSearchInput =
          input.labels.length > 0 ? { ...base, labels: input.labels } : base;
        const hits = yield* db.vectors.search(query).pipe(Effect.mapError(fromCheguers));
        return hits.map(
          (hit): SearchHit => ({
            ...summarize(hit.record.id, hit.record.data, hit.record.labels),
            score: 1 - hit.distance,
            via: "vector",
          }),
        );
      });

    const hybridSearch = (input: SearchInput, vector: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const base: HybridQuery = {
          vector,
          namespace: MEMORY_NAMESPACE,
          metric: "cosine",
          seeds: Math.max(input.limit, 10),
          expandDepth: input.expandDepth,
          direction: "both",
          // Over-fetch: document records reached through HAS_CHUNK are dropped below.
          topN: input.limit * 2 + 4,
          includeProvenance: true,
        };
        const query: HybridQuery =
          input.labels.length > 0 ? { ...base, labels: input.labels } : base;
        const hits = yield* db.hybrid.search(query).pipe(Effect.mapError(fromCheguers));
        const out: Array<SearchHit> = [];
        for (const hit of hits) {
          if (kindOf(hit.record.data) === "document") continue;
          // Labels narrow the vector seeds in SQL; graph expansion can reach
          // unlabeled items, so enforce the filter on final hits as well.
          const recordLabels: ReadonlyArray<string> = hit.record.labels;
          if (!input.labels.every((label) => recordLabels.includes(label))) continue;
          const provenance = hit.provenance;
          const depth = provenance?.graphDepth ?? 0;
          out.push({
            ...summarize(hit.record.id, hit.record.data, hit.record.labels),
            score: hit.score,
            via:
              depth === 0
                ? "vector"
                : `graph: ${depth} hop${depth === 1 ? "" : "s"} from ${provenance?.seedId ?? "seed"}`,
          });
          if (out.length >= input.limit) break;
        }
        return out;
      });

    const search = (input: SearchInput) =>
      Effect.gen(function* () {
        const query = yield* validate(() => validateText(input.query, "query"));
        const vector = yield* embedOne(query);
        const hits =
          config.retrieval === "hybrid" && input.expandDepth > 0
            ? yield* hybridSearch(input, vector)
            : yield* vectorSearch(input, vector);
        return { hits };
      });

    const get = (id: string) =>
      db.records.get(id).pipe(
        Effect.mapError((error) =>
          error._tag === "NotFoundError" || error._tag === "ValidationError"
            ? new MemoryError({ message: `no memory item with id ${id}` })
            : fromCheguers(error),
        ),
        Effect.map(toItem),
      );

    const link = (input: LinkInput) =>
      Effect.gen(function* () {
        const type = yield* validate(() => validateRelationType(input.type));
        const created = yield* db.relationships
          .create({ type, sourceId: input.sourceId, targetId: input.targetId })
          .pipe(Effect.mapError(linkError(input.sourceId, input.targetId)));
        counters.links++;
        return { id: created.id };
      });

    const neighbors = (input: NeighborsInput) =>
      Effect.gen(function* () {
        const types = yield* validate(() => input.types.map(validateRelationType));
        const base = {
          startIds: [input.id],
          direction: input.direction,
          minDepth: 1,
          maxDepth: input.depth,
          limit: input.limit,
          includePaths: true,
        } as const;
        const result = yield* db.traversal
          .traverse(types.length > 0 ? { ...base, relationshipTypes: types } : base)
          .pipe(Effect.mapError(fromCheguers));
        return {
          neighbors: result.hits.map((hit, index) => {
            const steps = result.paths?.[index];
            return {
              ...summarize(hit.record.id, hit.record.data, hit.record.labels),
              depth: hit.depth,
              route: steps === undefined ? undefined : steps.map((step) => step.type).join(" > "),
            };
          }),
        };
      });

    const stats: Effect.Effect<BackendStats, MemoryError> = Effect.sync(() => ({
      backend: config.retrieval === "hybrid" ? "cheguers" : "vector-only",
      embedder: embedder.id,
      notes: counters.notes,
      documents: counters.documents,
      chunks: counters.chunks,
      links: counters.links,
      vectors: counters.vectors,
      storageBytes:
        fileBytes(config.dbPath) +
        fileBytes(`${config.dbPath}-wal`) +
        fileBytes(`${config.dbPath}-shm`),
    }));

    return {
      kind: config.retrieval === "hybrid" ? "cheguers" : "vector-only",
      store,
      ingest,
      search,
      get,
      link,
      neighbors,
      stats,
      close: db.close.pipe(Effect.ignore),
    } satisfies MemoryBackend;
  });
