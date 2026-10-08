import {
  isBooleanValue,
  isNumberValue,
  isPlainObject,
  isStringValue,
  type JsonObject,
  type JsonValue,
} from "@cheguers/core";
import { MemoryError } from "../errors.js";
import { snippetOf, type MemoryItemSummary, type MemoryKind, type MetadataValue } from "./types.js";

/** Label every memory item carries, so memory records never mix with other data. */
export const MEMORY_LABEL = "memory";

/** Relationship from a document to each of its chunks. */
export const HAS_CHUNK = "HAS_CHUNK";
/** Relationship from a chunk to the following chunk of the same document. */
export const NEXT_CHUNK = "NEXT_CHUNK";

export const DEFAULT_LINK_TYPE = "RELATED";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export const KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  note: "note",
  document: "document",
  chunk: "chunk",
};

const RESERVED_LABELS = new Set<string>([MEMORY_LABEL, ...Object.values(KIND_LABELS)]);

/**
 * Validates caller labels and prepends the system labels. Reserved labels are
 * rejected so a note can never masquerade as a document chunk.
 */
export const memoryLabels = (
  kind: MemoryKind,
  labels: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  for (const label of labels) {
    if (!NAME_PATTERN.test(label)) {
      throw new MemoryError({
        message: `invalid label ${JSON.stringify(label)}: use letters, digits, _ . : - (max 128 chars)`,
      });
    }
    if (RESERVED_LABELS.has(label)) {
      throw new MemoryError({ message: `label ${JSON.stringify(label)} is reserved` });
    }
  }
  return [MEMORY_LABEL, KIND_LABELS[kind], ...new Set(labels)];
};

/** Labels shown to the agent: system labels stripped. */
export const userLabels = (labels: ReadonlyArray<string>): ReadonlyArray<string> =>
  labels.filter((label) => !RESERVED_LABELS.has(label));

export const validateRelationType = (type: string): string => {
  if (!NAME_PATTERN.test(type)) {
    throw new MemoryError({
      message: `invalid relationship type ${JSON.stringify(type)}: use letters, digits, _ . : -`,
    });
  }
  return type;
};

export const validateText = (text: string, field: string): string => {
  if (text.trim().length === 0) {
    throw new MemoryError({ message: `${field} must not be empty` });
  }
  return text;
};

/** Text that gets embedded for a note: the title adds retrieval context. */
export const noteEmbeddingText = (title: string | undefined, text: string): string =>
  title === undefined ? text : `${title}\n${text}`;

/** Text that gets embedded for a chunk: the path disambiguates similar files. */
export const chunkEmbeddingText = (path: string, text: string): string => `${path}\n${text}`;

export const basename = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

const readString = (data: JsonObject, key: string): string | undefined => {
  const value = data[key];
  return value !== undefined && isStringValue(value) ? value : undefined;
};

const readNumber = (data: JsonObject, key: string): number | undefined => {
  const value = data[key];
  return value !== undefined && isNumberValue(value) ? value : undefined;
};

export const kindOf = (data: JsonObject): MemoryKind => {
  const kind = readString(data, "kind");
  return kind === "document" || kind === "chunk" ? kind : "note";
};

export const textOf = (data: JsonObject): string => {
  if (kindOf(data) === "document") {
    const path = readString(data, "path") ?? "";
    const chunks = readNumber(data, "chunkCount") ?? 0;
    return `document ${path} (${chunks} chunks)`;
  }
  return readString(data, "text") ?? "";
};

export const metadataOf = (data: JsonObject): Readonly<Record<string, MetadataValue>> => {
  const raw = data.metadata;
  const out: Record<string, MetadataValue> = {};
  if (raw === undefined || !isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || isStringValue(value) || isNumberValue(value) || isBooleanValue(value)) {
      out[key] = value;
    }
  }
  return out;
};

export const summarize = (
  id: string,
  data: JsonObject,
  labels: ReadonlyArray<string>,
): MemoryItemSummary => {
  const kind = kindOf(data);
  const startLine = readNumber(data, "startLine");
  const endLine = readNumber(data, "endLine");
  return {
    id,
    kind,
    title: readString(data, "title"),
    path: readString(data, "path"),
    lines: startLine === undefined || endLine === undefined ? undefined : `${startLine}-${endLine}`,
    labels: userLabels(labels),
    snippet: snippetOf(textOf(data)),
  };
};

/** Note payload stored as the record's canonical JSON. */
export const noteData = (
  text: string,
  title: string | undefined,
  metadata: Readonly<Record<string, MetadataValue>>,
): JsonObject => {
  const data: Record<string, JsonValue> = { kind: "note", text, metadata: { ...metadata } };
  if (title !== undefined) data.title = title;
  return data;
};

export const documentData = (path: string, chunkCount: number, chars: number): JsonObject => ({
  kind: "document",
  path,
  title: basename(path),
  chunkCount,
  chars,
});

export const chunkData = (
  path: string,
  text: string,
  chunkIndex: number,
  startLine: number,
  endLine: number,
): JsonObject => ({
  kind: "chunk",
  path,
  title: basename(path),
  text,
  chunkIndex,
  startLine,
  endLine,
});

export const clampInteger = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

/**
 * Text a backend indexes for retrieval, mirroring what the CheguersDB arms
 * embed: notes as title + text, chunks as path + text, documents not at all.
 */
export const retrievalText = (data: JsonObject): string => {
  switch (kindOf(data)) {
    case "document":
      return "";
    case "chunk":
      return chunkEmbeddingText(readString(data, "path") ?? "", textOf(data));
    case "note":
      return noteEmbeddingText(readString(data, "title"), textOf(data));
  }
};
