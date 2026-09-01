import { Context, Effect, Layer } from "effect";
import { NotFoundError, ValidationError, type CheguersError } from "../errors.js";
import { asRecordId, isLabelName, isRecordId } from "../domain/ids.js";
import type {
  CheguersRecord,
  CheguersVectorMeta,
  UpsertVectorInput,
  VectorMetric,
  VectorSearchHit,
} from "../domain/model.js";
import { TursoAdapter } from "../database/turso.js";
import { readNumberColumn, readRecordIdColumn, readStringColumn } from "../database/row-parsers.js";
import type { SqlExecutor } from "../database/sql.js";
import { nowIso } from "../database/sql.js";
import { isNumberValue } from "../json/runtime.js";
import { hydrateRecordsFromRows } from "../query/executor.js";
import type { FilterAst } from "../query/ast.js";
import type { WhereExpression } from "../query/types.js";
import { parseWhereExpression } from "../query/parser.js";
import { compileFilter } from "../query/compiler/index.js";
import {
  DEFAULT_VECTOR_NAMESPACE,
  decodeVector,
  distanceBetween,
  encodeVector,
  isValidNamespace,
  validateVectorInput,
} from "./math.js";

export const MAX_TOP_K = 10000;

export interface VectorSearchInput {
  readonly namespace?: string;
  readonly vector: ReadonlyArray<number>;
  readonly metric: VectorMetric;
  readonly topK?: number;
  /** Exclusive upper bound on returned distances. */
  readonly maxDistance?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly where?: WhereExpression;
}

export class VectorService extends Context.Service<VectorService, VectorApi>()(
  "cheguers/db/VectorService",
) {}

export interface VectorApi {
  readonly upsert: (input: UpsertVectorInput) => Effect.Effect<CheguersVectorMeta, CheguersError>;
  readonly get: (
    recordId: string,
    namespace?: string,
  ) => Effect.Effect<CheguersVectorMeta, CheguersError>;
  readonly remove: (recordId: string, namespace?: string) => Effect.Effect<void, CheguersError>;
  readonly search: (
    input: VectorSearchInput,
  ) => Effect.Effect<ReadonlyArray<VectorSearchHit>, CheguersError>;
}

interface ParsedNamespace extends Record<string, unknown> {
  readonly namespace: string;
}

const parseNamespace = (
  raw: string | undefined,
): Effect.Effect<ParsedNamespace, ValidationError> => {
  if (raw === undefined) return Effect.succeed({ namespace: DEFAULT_VECTOR_NAMESPACE });
  return isValidNamespace(raw)
    ? Effect.succeed({ namespace: raw })
    : Effect.fail(new ValidationError({ message: `invalid vector namespace: ${raw}` }));
};

const parseRecordRef = (recordId: string): Effect.Effect<string, CheguersError> =>
  isRecordId(recordId)
    ? Effect.succeed(recordId)
    : Effect.fail(new ValidationError({ message: `invalid record id: ${recordId}` }));

const resolveInternalRecord = (
  tx: SqlExecutor,
  publicId: string,
): Effect.Effect<number, CheguersError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () => tx.get("SELECT id FROM records WHERE public_id = ?", publicId),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "record lookup failed", cause }),
    });
    if (row === undefined) {
      return yield* Effect.fail(new NotFoundError({ kind: "record", id: publicId }));
    }
    return readNumberColumn(row, "id");
  });

const metaFromRow = (row: Parameters<typeof readRecordIdColumn>[0]): CheguersVectorMeta => ({
  recordId: readRecordIdColumn(row, "public_id"),
  namespace: readStringColumn(row, "namespace"),
  dimensions: readNumberColumn(row, "dimensions"),
  updatedAt: readStringColumn(row, "updated_at"),
});

const VECTOR_COLUMNS =
  "v.record_id AS record_id, r.public_id AS public_id, v.namespace AS namespace, v.dimensions AS dimensions, v.vector AS vector, v.updated_at AS updated_at";

export const upsertVectorInTx = (
  tx: SqlExecutor,
  input: UpsertVectorInput,
): Effect.Effect<CheguersVectorMeta, CheguersError> =>
  Effect.gen(function* () {
    const { namespace } = yield* parseNamespace(input.namespace);
    const publicId = yield* parseRecordRef(input.recordId);
    let dimensions: number;
    try {
      dimensions = validateVectorInput(input.vector).dimensions;
    } catch (error) {
      return yield* Effect.fail(
        new ValidationError({
          message: error instanceof Error ? error.message : "invalid vector",
          cause: error,
        }),
      );
    }
    const internalId = yield* resolveInternalRecord(tx, publicId);

    // Dimension consistency per namespace: every stored vector in a namespace
    // must share one dimensionality so exact search stays well-defined.
    const mismatched = yield* Effect.tryPromise({
      try: () =>
        tx.get(
          "SELECT dimensions FROM vectors WHERE namespace = ? AND dimensions != ? LIMIT 1",
          namespace,
          dimensions,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "dimension check failed", cause }),
    });
    if (mismatched !== undefined) {
      return yield* Effect.fail(
        new ValidationError({
          message: `namespace "${namespace}" expects ${String(mismatched.dimensions)} dimensions, received ${dimensions}`,
        }),
      );
    }

    const timestamp = nowIso();
    yield* Effect.tryPromise({
      try: () =>
        tx
          .run(
            `INSERT INTO vectors (record_id, namespace, dimensions, vector, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(record_id, namespace) DO UPDATE SET
             dimensions = excluded.dimensions,
             vector = excluded.vector,
             updated_at = excluded.updated_at`,
            internalId,
            namespace,
            dimensions,
            encodeVector(input.vector),
            timestamp,
          )
          .then(() => undefined),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "vector upsert failed", cause }),
    });
    return {
      recordId: asRecordId(publicId),
      namespace,
      dimensions,
      updatedAt: timestamp,
    };
  });

const getInTx = (
  tx: SqlExecutor,
  recordId: string,
  namespace: string | undefined,
): Effect.Effect<CheguersVectorMeta, CheguersError> =>
  Effect.gen(function* () {
    const ns = yield* parseNamespace(namespace);
    const publicId = yield* parseRecordRef(recordId);
    const row = yield* Effect.tryPromise({
      try: () =>
        tx.get(
          `SELECT ${VECTOR_COLUMNS}
           FROM vectors v JOIN records r ON r.id = v.record_id
           WHERE v.record_id = (SELECT id FROM records WHERE public_id = ?)
             AND v.namespace = ?`,
          publicId,
          ns.namespace,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "vector lookup failed", cause }),
    });
    if (row === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ kind: "vector", id: `${publicId}@${ns.namespace}` }),
      );
    }
    return metaFromRow(row);
  });

export const deleteVectorInTx = (
  tx: SqlExecutor,
  recordId: string,
  namespace: string | undefined,
): Effect.Effect<void, CheguersError> =>
  Effect.gen(function* () {
    const ns = yield* parseNamespace(namespace);
    const publicId = yield* parseRecordRef(recordId);
    const deleted = yield* Effect.tryPromise({
      try: () =>
        tx.run(
          `DELETE FROM vectors
           WHERE record_id = (SELECT id FROM records WHERE public_id = ?)
             AND namespace = ?`,
          publicId,
          ns.namespace,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "vector delete failed", cause }),
    });
    if (deleted.changes === 0) {
      return yield* Effect.fail(
        new NotFoundError({ kind: "vector", id: `${publicId}@${ns.namespace}` }),
      );
    }
  });

/**
 * Filter-first exact search: when graph/metadata predicates are present they
 * narrow the candidate set in SQL before any vector distance is computed.
 */
export const searchVectorsInTx = (
  tx: SqlExecutor,
  input: VectorSearchInput,
): Effect.Effect<ReadonlyArray<VectorSearchHit>, CheguersError> =>
  Effect.gen(function* () {
    const { namespace } = yield* parseNamespace(input.namespace);
    const metric: VectorMetric = input.metric === "l2" ? "l2" : "cosine";
    let dims: number;
    try {
      dims = validateVectorInput(input.vector).dimensions;
    } catch (error) {
      return yield* Effect.fail(
        new ValidationError({
          message: error instanceof Error ? error.message : "invalid query vector",
          cause: error,
        }),
      );
    }
    let topK = 10;
    if (input.topK !== undefined) {
      if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > MAX_TOP_K) {
        return yield* Effect.fail(
          new ValidationError({ message: `topK must be an integer in [1, ${MAX_TOP_K}]` }),
        );
      }
      topK = input.topK;
    }
    if (input.maxDistance !== undefined && !isNumberValue(input.maxDistance)) {
      return yield* Effect.fail(
        new ValidationError({ message: "maxDistance must be a finite number" }),
      );
    }
    let labels: ReadonlyArray<string> = [];
    if (input.labels !== undefined) {
      if (!Array.isArray(input.labels)) {
        return yield* Effect.fail(new ValidationError({ message: "labels must be an array" }));
      }
      for (const label of input.labels) {
        if (!isLabelName(label)) {
          return yield* Effect.fail(
            new ValidationError({ message: `invalid label name: ${JSON.stringify(label)}` }),
          );
        }
      }
      labels = [...new Set(input.labels)].sort();
    }
    let whereAst: FilterAst | undefined;
    try {
      whereAst = input.where === undefined ? undefined : parseWhereExpression(input.where);
    } catch (error) {
      if (error instanceof ValidationError) {
        return yield* Effect.fail(error);
      }
      throw error;
    }

    // Build the filter-first candidate SQL. Namespace first, then metadata and
    // graph predicates composed with the existing compiler so related-record
    // filters behave identically to db.query.find.
    const conditions: Array<string> = [];
    const params: Array<unknown> = [namespace];
    for (const label of labels) {
      conditions.push(
        "EXISTS(SELECT 1 FROM record_labels rl_q JOIN labels l_q ON l_q.id = rl_q.label_id WHERE rl_q.record_id = r.id AND l_q.name = ?)",
      );
      params.push(label);
    }
    if (whereAst !== undefined) {
      const compiled = compileFilter(whereAst, { alias: "r" }, { count: 0 });
      conditions.push(compiled.sql);
      params.push(...compiled.params);
    }
    const whereSql = conditions.length > 0 ? ` AND (${conditions.join(" AND ")})` : "";

    const rows = yield* Effect.tryPromise({
      try: () =>
        tx.all(
          `SELECT ${VECTOR_COLUMNS}
           FROM vectors v JOIN records r ON r.id = v.record_id
           WHERE v.namespace = ?${whereSql}`,
          ...params,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "vector candidate scan failed", cause }),
    });

    const queryVec = Float32Array.from(input.vector);
    interface Candidate {
      readonly publicId: string;
      readonly internalId: number;
      readonly distance: number;
    }
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const dims2 = readNumberColumn(row, "dimensions");
      if (dims2 !== dims) continue;
      const stored = decodeVector(row.vector, dims2);
      const distance = distanceBetween(metric, queryVec, stored);
      if (input.maxDistance !== undefined && distance > input.maxDistance) continue;
      candidates.push({
        publicId: readStringColumn(row, "public_id"),
        internalId: readNumberColumn(row, "record_id"),
        distance,
      });
    }
    candidates.sort((a, b) =>
      a.distance === b.distance ? a.publicId.localeCompare(b.publicId) : a.distance - b.distance,
    );
    const winners = candidates.slice(0, topK);

    // Hydrate full records for the winners only.
    if (winners.length === 0) return [];
    const placeholders = winners.map(() => "?").join(", ");
    const recordRows = yield* Effect.tryPromise({
      try: () =>
        tx.all(
          `SELECT id, public_id, data, created_at, updated_at FROM records
           WHERE id IN (${placeholders})
           ORDER BY public_id`,
          ...winners.map((w) => w.internalId),
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "vector result hydration failed", cause }),
    });
    const hydrated = yield* Effect.promise(() => hydrateRecordsFromRows(tx, recordRows));
    const byPublicId = new Map<string, CheguersRecord>(hydrated.map((r) => [r.id, r]));
    const hits: Array<VectorSearchHit> = [];
    for (const winner of winners) {
      const record = byPublicId.get(winner.publicId);
      if (record !== undefined) hits.push({ record, distance: winner.distance });
    }
    return hits;
  });

export const makeVectorService: Effect.Effect<VectorApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;

    return {
      upsert: (input) => adapter.transact((tx) => upsertVectorInTx(tx, input)),
      get: (recordId, namespace) => adapter.transact((tx) => getInTx(tx, recordId, namespace)),
      remove: (recordId, namespace) =>
        adapter.transact((tx) => deleteVectorInTx(tx, recordId, namespace)),
      search: (input) => adapter.transact((tx) => searchVectorsInTx(tx, input)),
    };
  },
);

export const vectorLayer = Layer.effect(VectorService, makeVectorService);
