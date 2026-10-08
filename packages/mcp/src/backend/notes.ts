import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { generateRecordId, type JsonObject } from "@cheguers/core";
import { chunkText } from "../chunking.js";
import { tokenize } from "../embedding/hash.js";
import { MemoryError } from "../errors.js";
import {
  HAS_CHUNK,
  NEXT_CHUNK,
  chunkData,
  documentData,
  kindOf,
  memoryLabels,
  metadataOf,
  noteData,
  retrievalText,
  summarize,
  textOf,
  validateRelationType,
  validateText,
} from "./common.js";
import type {
  IngestInput,
  IngestedDocument,
  LinkInput,
  MemoryBackend,
  MemoryItem,
  Neighbor,
  NeighborsInput,
  SearchHit,
  SearchInput,
  StoreInput,
} from "./types.js";

interface NoteEntry {
  readonly id: string;
  readonly data: JsonObject;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

interface NoteLink {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const termFrequencies = (text: string): { tf: Map<string, number>; length: number } => {
  const tf = new Map<string, number>();
  const tokens = tokenize(text);
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return { tf, length: tokens.length };
};

const validate = <A>(thunk: () => A): Effect.Effect<A, MemoryError> =>
  Effect.try({
    try: thunk,
    catch: (cause) =>
      cause instanceof MemoryError
        ? cause
        : new MemoryError({ message: cause instanceof Error ? cause.message : "invalid input" }),
  });

const relationshipId = (): string => `rel_${randomUUID().replace(/-/g, "")}`;

/**
 * Control arm: an in-process note store with BM25 keyword search. Same tool
 * surface and the same document chunking as the CheguersDB arms, but no
 * embeddings, no vector index and no database.
 */
export const makeNotesBackend = (): MemoryBackend => {
  const entries = new Map<string, NoteEntry>();
  const links: Array<NoteLink> = [];
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;

  const insert = (data: JsonObject, labels: ReadonlyArray<string>): NoteEntry => {
    const { tf, length } = termFrequencies(retrievalText(data));
    const entry: NoteEntry = {
      id: generateRecordId(),
      data,
      labels,
      createdAt: new Date().toISOString(),
      termFrequencies: tf,
      length,
    };
    entries.set(entry.id, entry);
    for (const term of tf.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
    totalLength += length;
    return entry;
  };

  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entries.delete(id);
    for (const term of entry.termFrequencies.keys()) {
      const next = (documentFrequencies.get(term) ?? 1) - 1;
      if (next <= 0) documentFrequencies.delete(term);
      else documentFrequencies.set(term, next);
    }
    totalLength -= entry.length;
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i]!;
      if (link.sourceId === id || link.targetId === id) links.splice(i, 1);
    }
  };

  const addLink = (type: string, sourceId: string, targetId: string): NoteLink => {
    for (const endpoint of [sourceId, targetId]) {
      if (!entries.has(endpoint))
        throw new MemoryError({ message: `record ${endpoint} not found` });
    }
    const link: NoteLink = { id: relationshipId(), type, sourceId, targetId };
    links.push(link);
    return link;
  };

  const store = (input: StoreInput) =>
    validate(() => {
      const text = validateText(input.text, "text");
      const labels = memoryLabels("note", input.labels);
      const types = input.links.map((link) => validateRelationType(link.type));
      for (const link of input.links) {
        if (!entries.has(link.targetId)) {
          throw new MemoryError({ message: `record ${link.targetId} not found` });
        }
      }
      const entry = insert(noteData(text, input.title, input.metadata), labels);
      input.links.forEach((link, i) => addLink(types[i]!, entry.id, link.targetId));
      return {
        id: entry.id,
        labels: summarize(entry.id, entry.data, labels).labels,
        links: input.links.length,
      };
    });

  const ingest = (input: IngestInput) =>
    validate(() => {
      const results: Array<IngestedDocument> = [];
      let totalChunks = 0;
      for (const document of input.documents) {
        const path = validateText(document.path, "path");
        const chunkLabels = memoryLabels("chunk", document.labels);
        const docLabels = memoryLabels("document", document.labels);
        const chunks = chunkText(document.content, {
          maxChars: input.maxChunkChars,
          overlapChars: Math.floor(input.maxChunkChars / 8),
        });
        for (const previous of [...entries.values()]) {
          if (kindOf(previous.data) !== "document" || previous.data.path !== path) continue;
          for (const link of links.filter(
            (l) => l.sourceId === previous.id && l.type === HAS_CHUNK,
          )) {
            remove(link.targetId);
          }
          remove(previous.id);
        }
        const doc = insert(documentData(path, chunks.length, document.content.length), docLabels);
        let previousId: string | undefined;
        for (const chunk of chunks) {
          const created = insert(
            chunkData(path, chunk.text, chunk.index, chunk.startLine, chunk.endLine),
            chunkLabels,
          );
          addLink(HAS_CHUNK, doc.id, created.id);
          if (previousId !== undefined) addLink(NEXT_CHUNK, previousId, created.id);
          previousId = created.id;
        }
        totalChunks += chunks.length;
        results.push({ path, documentId: doc.id, chunks: chunks.length });
      }
      return { documents: results, totalChunks };
    });

  const search = (input: SearchInput) =>
    validate(() => {
      const query = validateText(input.query, "query");
      const terms = [...new Set(tokenize(query))];
      const indexed = [...entries.values()].filter((entry) => kindOf(entry.data) !== "document");
      const averageLength = indexed.length === 0 ? 1 : Math.max(1, totalLength / indexed.length);
      const scored: Array<{ entry: NoteEntry; score: number }> = [];
      for (const entry of indexed) {
        if (!input.labels.every((label) => entry.labels.includes(label))) continue;
        let score = 0;
        for (const term of terms) {
          const frequency = entry.termFrequencies.get(term);
          if (frequency === undefined) continue;
          const df = documentFrequencies.get(term) ?? 0;
          const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5));
          score +=
            (idf * frequency * (BM25_K1 + 1)) /
            (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / averageLength));
        }
        if (score > 0) scored.push({ entry, score });
      }
      scored.sort((a, b) =>
        a.score === b.score ? a.entry.id.localeCompare(b.entry.id) : b.score - a.score,
      );
      const hits = scored.slice(0, input.limit).map(
        ({ entry, score }): SearchHit => ({
          ...summarize(entry.id, entry.data, entry.labels),
          score,
          via: "keyword",
        }),
      );
      return { hits };
    });

  const get = (id: string) =>
    validate((): MemoryItem => {
      const entry = entries.get(id);
      if (entry === undefined) throw new MemoryError({ message: `no memory item with id ${id}` });
      return {
        ...summarize(entry.id, entry.data, entry.labels),
        text: textOf(entry.data),
        metadata: metadataOf(entry.data),
        createdAt: entry.createdAt,
      };
    });

  const link = (input: LinkInput) =>
    validate(() => ({
      id: addLink(validateRelationType(input.type), input.sourceId, input.targetId).id,
    }));

  const neighbors = (input: NeighborsInput) =>
    validate(() => {
      if (!entries.has(input.id))
        throw new MemoryError({ message: `record ${input.id} not found` });
      const types = new Set(input.types.map(validateRelationType));
      const visited = new Map<string, { depth: number; route: string }>([
        [input.id, { depth: 0, route: "" }],
      ]);
      let frontier = [input.id];
      const out: Array<Neighbor> = [];
      for (let depth = 1; depth <= input.depth && frontier.length > 0; depth++) {
        const next: Array<string> = [];
        for (const nodeId of frontier) {
          const route = visited.get(nodeId)!.route;
          for (const edge of links) {
            if (types.size > 0 && !types.has(edge.type)) continue;
            const targets: Array<string> = [];
            if (input.direction !== "incoming" && edge.sourceId === nodeId)
              targets.push(edge.targetId);
            if (input.direction !== "outgoing" && edge.targetId === nodeId)
              targets.push(edge.sourceId);
            for (const target of targets) {
              if (visited.has(target)) continue;
              const nextRoute = route === "" ? edge.type : `${route} > ${edge.type}`;
              visited.set(target, { depth, route: nextRoute });
              next.push(target);
            }
          }
        }
        next.sort();
        for (const id of next) {
          const entry = entries.get(id)!;
          out.push({
            ...summarize(entry.id, entry.data, entry.labels),
            depth,
            route: visited.get(id)!.route,
          });
        }
        frontier = next;
      }
      return { neighbors: out.slice(0, input.limit) };
    });

  const countKind = (kind: "note" | "document" | "chunk"): number =>
    [...entries.values()].filter((entry) => kindOf(entry.data) === kind).length;

  return {
    kind: "notes",
    store,
    ingest,
    search,
    get,
    link,
    neighbors,
    stats: Effect.sync(() => ({
      backend: "notes",
      embedder: undefined,
      notes: countKind("note"),
      documents: countKind("document"),
      chunks: countKind("chunk"),
      links: links.length,
      vectors: 0,
      storageBytes: 0,
    })),
    close: Effect.void,
  };
};
