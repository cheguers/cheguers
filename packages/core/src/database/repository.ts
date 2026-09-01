import { Effect } from "effect"
import {
  ConflictError,
  ValidationError,
  type CheguersError
} from "../errors.js"
import type { LabelName } from "../domain/ids.js"
import type { JsonObject } from "../domain/model.js"
import type { SqlExecutor, SqlRow } from "./sql.js"

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message)

const dbFailure =
  (operation: string) =>
  (cause: unknown): CheguersError =>
    new ValidationError({ message: `${operation} failed`, cause })

export const ensureLabelLink = (
  tx: SqlExecutor,
  numericRecordId: number,
  name: LabelName
): Effect.Effect<void, CheguersError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        tx.run(
          "INSERT INTO labels (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
          name
        ).then(() => undefined),
      catch: dbFailure("upsert label")
    })
    const labelRow = (yield* Effect.tryPromise({
      try: () => tx.get("SELECT id FROM labels WHERE name = ?", name),
      catch: dbFailure("label lookup")
    })) as SqlRow
    const labelId = labelRow.id as number
    yield* Effect.tryPromise({
      try: () =>
        tx.run(
          "INSERT OR IGNORE INTO record_labels (record_id, label_id) VALUES (?, ?)",
          numericRecordId,
          labelId
        ).then(() => undefined),
      catch: dbFailure("link label")
    })
  })

export const unlinkLabel = (
  tx: SqlExecutor,
  numericRecordId: number,
  name: LabelName
): Effect.Effect<void, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      tx.run(
        "DELETE FROM record_labels WHERE record_id = ? AND label_id IN (SELECT id FROM labels WHERE name = ?)",
        numericRecordId,
        name
      ).then(() => undefined),
    catch: dbFailure("unlink label")
  })

export const insertRecord = (
  tx: SqlExecutor,
  props: {
    readonly publicId: string
    readonly data: JsonObject
    readonly timestamp: string
  }
): Effect.Effect<number, CheguersError> =>
  Effect.gen(function* () {
    const inserted = yield* Effect.tryPromise({
      try: () =>
        tx.run(
          "INSERT INTO records (public_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
          props.publicId,
          JSON.stringify(props.data),
          props.timestamp,
          props.timestamp
        ),
      catch: (cause): CheguersError =>
        isUniqueViolation(cause)
          ? new ConflictError({ message: `record already exists: ${props.publicId}` })
          : dbFailure("insert record")(cause)
    })
    return Number(inserted.lastInsertRowid)
  })

export const findInternalIdByPublicId = (
  tx: SqlExecutor,
  table: "records",
  publicId: string
): Effect.Effect<number | undefined, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      tx.get(`SELECT id FROM ${table} WHERE public_id = ?`, publicId).then(
        (row) => (row === undefined ? undefined : (row.id as number))
      ),
    catch: dbFailure("locate record")
  })

export const loadRecordJson = (
  tx: SqlExecutor,
  internalId: number
): Effect.Effect<string | undefined, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      tx
        .get("SELECT data FROM records WHERE id = ?", internalId)
        .then((row) => (row === undefined ? undefined : (row.data as string))),
    catch: dbFailure("load record data")
  })

export const touchRecord = (
  tx: SqlExecutor,
  internalId: number,
  mergedData: JsonObject,
  timestamp: string
): Effect.Effect<void, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      tx.run(
        "UPDATE records SET data = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(mergedData),
        timestamp,
        internalId
      ).then(() => undefined),
    catch: dbFailure("update record")
  })

export const deleteDependentsAndRecord = (
  tx: SqlExecutor,
  internalId: number
): Effect.Effect<number, CheguersError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        tx.run("DELETE FROM record_labels WHERE record_id = ?", internalId).then(() => undefined),
      catch: dbFailure("unlink record labels")
    })
    yield* Effect.tryPromise({
      try: () =>
        tx.run("DELETE FROM vectors WHERE record_id = ?", internalId).then(() => undefined),
      catch: dbFailure("delete record vectors")
    })
    yield* Effect.tryPromise({
      try: () =>
        tx.run(
          "DELETE FROM relationships WHERE source_id = ? OR target_id = ?",
          internalId,
          internalId
        ).then(() => undefined),
      catch: dbFailure("delete incident relationships")
    })
    const deleted = yield* Effect.tryPromise({
      try: () => tx.run("DELETE FROM records WHERE id = ?", internalId),
      catch: dbFailure("delete record")
    })
    return deleted.changes
  })

export const selectRecordRowsByPublicIds = (
  tx: SqlExecutor,
  publicIds: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<SqlRow>, CheguersError> => {
  if (publicIds.length === 0) return Effect.succeed([])
  const placeholders = publicIds.map(() => "?").join(", ")
  return Effect.tryPromise({
    try: () =>
      tx.all(
        `SELECT id, public_id, data, created_at, updated_at FROM records WHERE public_id IN (${placeholders})`,
        ...publicIds
      ) as Promise<ReadonlyArray<SqlRow>>,
    catch: dbFailure("select records")
  })
}
