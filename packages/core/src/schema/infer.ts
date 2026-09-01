import type { JsonObject, JsonValue } from "../domain/model.js";
import type { SqlExecutor } from "../database/sql.js";
import { isBooleanValue, isNumberValue, isStringValue } from "../json/runtime.js";

export type InferredType = "string" | "number" | "boolean" | "null" | "datetime";

export interface PropertyObservation {
  readonly label: string;
  readonly property: string;
  readonly inferredType: InferredType;
}

const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const inferType = (value: JsonValue): InferredType => {
  if (value === null) return "null";
  if (isStringValue(value)) {
    return DATETIME_PATTERN.test(value) ? "datetime" : "string";
  }
  if (isNumberValue(value)) return "number";
  if (isBooleanValue(value)) return "boolean";
  return "string";
};

const TYPE_PRECEDENCE = {
  null: 0,
  datetime: 1,
  string: 2,
  number: 3,
  boolean: 4,
} satisfies Record<InferredType, number>;

export const reconcileType = (existing: InferredType, incoming: InferredType): InferredType => {
  if (existing === incoming) return incoming;
  if (existing === "null") return incoming;
  if (incoming === "null") return existing;
  if (existing === "datetime" && incoming === "string") return "datetime";
  if (existing === "string" && incoming === "datetime") return "datetime";
  return TYPE_PRECEDENCE[existing] <= TYPE_PRECEDENCE[incoming] ? existing : incoming;
};

/**
 * Collect top-level property observations from a record's JSON.
 * Nested objects/arrays are stored as their stringified JSON and
 * observed as `string` — user JSON remains canonical; the catalog is
 * metadata only.
 */
export const observeProperties = (
  label: string,
  data: JsonObject,
): ReadonlyArray<PropertyObservation> =>
  Object.entries(data).map(([property, value]) => ({
    label,
    property,
    inferredType: inferType(value),
  }));

export interface CatalogEntry {
  readonly label: string;
  readonly property: string;
  readonly inferredType: InferredType;
}

export const collectCatalogEntries = (
  labels: ReadonlyArray<string>,
  data: JsonObject,
): ReadonlyArray<CatalogEntry> => {
  const entries = new Map<string, CatalogEntry>();
  for (const label of labels) {
    for (const obs of observeProperties(label, data)) {
      const key = `${obs.label}\u0000${obs.property}`;
      const existing = entries.get(key);
      if (existing === undefined) {
        entries.set(key, {
          label: obs.label,
          property: obs.property,
          inferredType: obs.inferredType,
        });
      } else if (existing.inferredType !== obs.inferredType) {
        entries.set(key, {
          ...existing,
          inferredType: reconcileType(existing.inferredType, obs.inferredType),
        });
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.property.localeCompare(b.property),
  );
};

export const recordCatalogChanges = (
  tx: SqlExecutor,
  labels: ReadonlyArray<string>,
  data: JsonObject,
  timestamp: string,
): Promise<void> => {
  const entries = collectCatalogEntries(labels, data);
  return Promise.all(
    entries.map((entry) =>
      tx
        .run(
          `INSERT INTO schema_catalog (label, property, inferred_type, observations, first_seen, last_seen)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(label, property) DO UPDATE SET
           observations = observations + 1,
           last_seen = excluded.last_seen`,
          entry.label,
          entry.property,
          entry.inferredType,
          timestamp,
          timestamp,
        )
        .then(() => undefined),
    ),
  ).then(() => undefined);
};
