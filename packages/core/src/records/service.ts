import { Context, Effect, Layer } from "effect";
import { NotFoundError, ValidationError, type CheguersError } from "../errors.js";
import {
  asRecordId,
  generateRecordId,
  isLabelName,
  isRecordId,
  type LabelName,
} from "../domain/ids.js";
import type {
  CheguersRecord,
  CreateRecordInput,
  JsonObject,
  UpdateRecordInput,
} from "../domain/model.js";
import { TursoAdapter } from "../database/turso.js";
import {
  deleteDependentsAndRecord,
  ensureLabelLink,
  insertRecord,
  unlinkLabel,
} from "../database/repository.js";
import {
  hydrateRecordFromRow,
  readJsonObjectColumn,
  readLabelNameColumn,
  recordKeyFromRow,
} from "../database/row-parsers.js";
import type { SqlExecutor } from "../database/sql.js";
import { nowIso } from "../database/sql.js";
import { isPlainObject } from "../json/runtime.js";
import { recordCatalogChanges } from "../schema/infer.js";

export const normalizeLabels = (
  labels: ReadonlyArray<string> | undefined,
): ReadonlyArray<LabelName> => {
  if (labels === undefined) return [];
  const seen = new Set<LabelName>();
  for (const raw of labels) {
    if (!isLabelName(raw)) {
      throw new ValidationError({
        message: `invalid label name: ${JSON.stringify(raw)}`,
      });
    }
    seen.add(raw);
  }
  return [...seen].sort();
};

const validateDataObject = (data: JsonObject): Effect.Effect<JsonObject, ValidationError> =>
  isPlainObject(data)
    ? Effect.succeed(data)
    : Effect.fail(new ValidationError({ message: "record data must be a plain JSON object" }));

const parseRecordId = (value: string): Effect.Effect<string, ValidationError> =>
  isRecordId(value)
    ? Effect.succeed(value)
    : Effect.fail(new ValidationError({ message: `invalid record id: ${value}` }));

const createInTx = (
  tx: SqlExecutor,
  input: CreateRecordInput,
): Effect.Effect<CheguersRecord, CheguersError> =>
  Effect.gen(function* () {
    yield* validateDataObject(input.data);
    let labels: ReadonlyArray<LabelName>;
    try {
      labels = normalizeLabels(input.labels);
    } catch (error) {
      if (error instanceof ValidationError) {
        return yield* Effect.fail(error);
      }
      throw error;
    }

    let publicId: string;
    if (input.id === undefined) {
      publicId = generateRecordId();
    } else if (!isRecordId(input.id)) {
      return yield* Effect.fail(new ValidationError({ message: `invalid record id: ${input.id}` }));
    } else {
      publicId = input.id;
    }

    const timestamp = nowIso();
    const numericId = yield* insertRecord(tx, {
      publicId,
      data: input.data,
      timestamp,
    });
    for (const name of labels) yield* ensureLabelLink(tx, numericId, name);
    yield* Effect.tryPromise({
      try: () => recordCatalogChanges(tx, labels, input.data, timestamp),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "schema catalog update failed", cause }),
    });
    return {
      id: asRecordId(publicId),
      data: input.data,
      labels: [...labels],
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies CheguersRecord;
  });

const getInTx = (tx: SqlExecutor, rawId: string): Effect.Effect<CheguersRecord, CheguersError> =>
  Effect.gen(function* () {
    const id = yield* parseRecordId(rawId);
    const { row, key } = yield* withRecordForUpdate(tx, id);
    return yield* Effect.promise(() => hydrateRecordFromRow(tx, key, row));
  });

const withRecordForUpdate = (
  tx: SqlExecutor,
  publicId: string,
): Effect.Effect<
  { row: Parameters<typeof hydrateRecordFromRow>[2]; key: ReturnType<typeof recordKeyFromRow> },
  CheguersError
> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        tx.get(
          "SELECT id, public_id, data, created_at, updated_at FROM records WHERE public_id = ?",
          publicId,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "record lookup failed", cause }),
    });
    if (row === undefined) {
      return yield* Effect.fail(new NotFoundError({ kind: "record", id: publicId }));
    }
    return { row, key: recordKeyFromRow(row) };
  });

const updateInTx = (
  tx: SqlExecutor,
  rawId: string,
  input: UpdateRecordInput,
): Effect.Effect<CheguersRecord, CheguersError> =>
  Effect.gen(function* () {
    const id = yield* parseRecordId(rawId);
    const nextPatch: JsonObject | undefined =
      input.data === undefined ? undefined : yield* validateDataObject(input.data);
    let addLabels: ReadonlyArray<LabelName>;
    let removeLabels: ReadonlyArray<LabelName>;
    try {
      addLabels = normalizeLabels(input.addLabels);
      removeLabels = normalizeLabels(input.removeLabels);
    } catch (error) {
      if (error instanceof ValidationError) {
        return yield* Effect.fail(error);
      }
      throw error;
    }

    const { row, key } = yield* withRecordForUpdate(tx, id);
    const currentData = readJsonObjectColumn(row, "data");
    const merged: JsonObject =
      nextPatch === undefined ? currentData : { ...currentData, ...nextPatch };
    const timestamp = nowIso();

    yield* touchRecordInternal(tx, key.numericId, merged, timestamp);

    for (const name of addLabels) yield* ensureLabelLink(tx, key.numericId, name);
    for (const name of removeLabels) yield* unlinkLabel(tx, key.numericId, name);

    if (nextPatch !== undefined) {
      const finalLabelRows = yield* Effect.tryPromise({
        try: () =>
          tx.all(
            `SELECT l.name AS name FROM record_labels rl JOIN labels l ON l.id = rl.label_id
             WHERE rl.record_id = ? ORDER BY l.name`,
            key.numericId,
          ),
        catch: (cause): CheguersError =>
          new ValidationError({ message: "label lookup failed", cause }),
      });
      const finalLabels = finalLabelRows.map((labelRow) => readLabelNameColumn(labelRow, "name"));
      yield* Effect.tryPromise({
        try: () => recordCatalogChanges(tx, finalLabels, merged, timestamp),
        catch: (cause): CheguersError =>
          new ValidationError({ message: "schema catalog update failed", cause }),
      });
    }

    const refreshed = yield* withRecordForUpdate(tx, id);
    return yield* Effect.promise(() => hydrateRecordFromRow(tx, refreshed.key, refreshed.row));
  });

const touchRecordInternal = (
  tx: SqlExecutor,
  internalId: number,
  mergedData: JsonObject,
  timestamp: string,
): Effect.Effect<void, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      tx
        .run(
          "UPDATE records SET data = ?, updated_at = ? WHERE id = ?",
          JSON.stringify(mergedData),
          timestamp,
          internalId,
        )
        .then(() => undefined),
    catch: (cause): CheguersError =>
      new ValidationError({ message: "update record failed", cause }),
  });

const deleteInTx = (tx: SqlExecutor, rawId: string): Effect.Effect<void, CheguersError> =>
  Effect.gen(function* () {
    const id = yield* parseRecordId(rawId);
    const { key } = yield* withRecordForUpdate(tx, id);
    yield* deleteDependentsAndRecord(tx, key.numericId).pipe(Effect.asVoid);
  });

export const createRecordInTx = createInTx;
export const updateRecordInTx = updateInTx;
export const deleteRecordInTx = deleteInTx;

const listByLabelsInTx = (
  tx: SqlExecutor,
  labels: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError> =>
  Effect.gen(function* () {
    let normalized: ReadonlyArray<LabelName>;
    try {
      normalized = normalizeLabels(labels);
    } catch (error) {
      if (error instanceof ValidationError) {
        return yield* Effect.fail(error);
      }
      throw error;
    }
    if (normalized.length === 0) return [];
    const placeholders = normalized.map(() => "?").join(", ");
    const rows = yield* Effect.tryPromise({
      try: () =>
        tx.all(
          `SELECT r.id, r.public_id, r.data, r.created_at, r.updated_at
           FROM records r
           JOIN record_labels rl ON rl.record_id = r.id
           JOIN labels l ON l.id = rl.label_id
           WHERE l.name IN (${placeholders})
           GROUP BY r.id, r.public_id, r.data, r.created_at, r.updated_at
           HAVING COUNT(DISTINCT l.name) = ?
           ORDER BY r.public_id`,
          ...normalized,
          normalized.length,
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "list by labels failed", cause }),
    });
    const result: Array<CheguersRecord> = [];
    for (const row of rows) {
      result.push(
        yield* Effect.promise(() => hydrateRecordFromRow(tx, recordKeyFromRow(row), row)),
      );
    }
    return result;
  });

export class RecordsService extends Context.Service<RecordsService, RecordsApi>()(
  "cheguers/db/RecordsService",
) {}

export interface RecordsApi {
  readonly create: (input: CreateRecordInput) => Effect.Effect<CheguersRecord, CheguersError>;
  readonly get: (id: string) => Effect.Effect<CheguersRecord, CheguersError>;
  readonly update: (
    id: string,
    input: UpdateRecordInput,
  ) => Effect.Effect<CheguersRecord, CheguersError>;
  readonly delete: (id: string) => Effect.Effect<void, CheguersError>;
  readonly listByLabels: (
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError>;
}

export const makeRecordsService: Effect.Effect<RecordsApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;

    return {
      create: (input) => adapter.transact((tx) => createInTx(tx, input)),
      get: (id) => adapter.transact((tx) => getInTx(tx, id)),
      update: (id, input) => adapter.transact((tx) => updateInTx(tx, id, input)),
      delete: (id) => adapter.transact((tx) => deleteInTx(tx, id)),
      listByLabels: (labels) => adapter.transact((tx) => listByLabelsInTx(tx, labels)),
    };
  },
);

export const recordsLayer = Layer.effect(RecordsService, makeRecordsService);

export const withNewPublicId = generateRecordId;
