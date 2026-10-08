import type { Effect } from "effect";
import type { MemoryError } from "../errors.js";

/**
 * Benchmark arm served by the MCP server. All arms expose the same tools with
 * the same descriptions; only the storage/retrieval engine behind them changes.
 *
 * - `cheguers`: CheguersDB with HybridRAG (vector seeds + graph expansion).
 * - `vector-only`: CheguersDB with plain vector search (graph ablation).
 * - `notes`: in-memory notes with keyword (BM25) search, no embeddings, no DB.
 */
export type BackendKind = "cheguers" | "vector-only" | "notes";

export const BACKEND_KINDS: ReadonlyArray<BackendKind> = ["cheguers", "vector-only", "notes"];

export type MemoryKind = "note" | "document" | "chunk";

export type MetadataValue = string | number | boolean | null;

export interface StoreLink {
  readonly targetId: string;
  readonly type: string;
}

export interface StoreInput {
  readonly text: string;
  readonly title: string | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
  readonly links: ReadonlyArray<StoreLink>;
}

export interface StoreResult {
  readonly id: string;
  readonly labels: ReadonlyArray<string>;
  readonly links: number;
}

export interface IngestDocument {
  readonly path: string;
  readonly content: string;
  readonly labels: ReadonlyArray<string>;
}

export interface IngestInput {
  readonly documents: ReadonlyArray<IngestDocument>;
  readonly maxChunkChars: number;
}

export interface IngestedDocument {
  readonly path: string;
  readonly documentId: string;
  readonly chunks: number;
}

export interface IngestResult {
  readonly documents: ReadonlyArray<IngestedDocument>;
  readonly totalChunks: number;
}

export type SearchDirection = "outgoing" | "incoming" | "both";

export interface SearchInput {
  readonly query: string;
  readonly limit: number;
  readonly labels: ReadonlyArray<string>;
  /** Graph hops explored around vector seeds (ignored by non-graph arms). */
  readonly expandDepth: number;
}

export interface MemoryItemSummary {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly title: string | undefined;
  readonly path: string | undefined;
  /** `start-end` line range for document chunks. */
  readonly lines: string | undefined;
  readonly labels: ReadonlyArray<string>;
  /** Leading excerpt of the stored text. */
  readonly snippet: string;
}

export interface SearchHit extends MemoryItemSummary {
  readonly score: number;
  /** How the hit was reached, e.g. `vector` or `graph:2 hops via rec_…`. */
  readonly via: string;
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
}

export interface MemoryItem extends MemoryItemSummary {
  readonly text: string;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
  readonly createdAt: string;
}

export interface LinkInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
}

export interface LinkResult {
  readonly id: string;
}

export interface NeighborsInput {
  readonly id: string;
  readonly depth: number;
  readonly direction: SearchDirection;
  readonly types: ReadonlyArray<string>;
  readonly limit: number;
}

export interface Neighbor extends MemoryItemSummary {
  readonly depth: number;
  /** Relationship types along the first path that reached this item. */
  readonly route: string | undefined;
}

export interface NeighborsResult {
  readonly neighbors: ReadonlyArray<Neighbor>;
}

export interface BackendStats {
  readonly backend: BackendKind;
  readonly embedder: string | undefined;
  readonly notes: number;
  readonly documents: number;
  readonly chunks: number;
  readonly links: number;
  readonly vectors: number;
  /** On-disk size of the database files, when the backend has any. */
  readonly storageBytes: number;
}

export interface MemoryBackend {
  readonly kind: BackendKind;
  readonly store: (input: StoreInput) => Effect.Effect<StoreResult, MemoryError>;
  readonly ingest: (input: IngestInput) => Effect.Effect<IngestResult, MemoryError>;
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, MemoryError>;
  readonly get: (id: string) => Effect.Effect<MemoryItem, MemoryError>;
  readonly link: (input: LinkInput) => Effect.Effect<LinkResult, MemoryError>;
  readonly neighbors: (input: NeighborsInput) => Effect.Effect<NeighborsResult, MemoryError>;
  readonly stats: Effect.Effect<BackendStats, MemoryError>;
  readonly close: Effect.Effect<void>;
}

export const SNIPPET_CHARS = 600;

export const snippetOf = (text: string): string =>
  text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS)}…`;
