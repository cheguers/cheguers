import { Effect } from "effect"
import type { SqlExecutor, SqlRow } from "../database/sql.js"
import { asRecordId, type LabelName } from "../domain/ids.js"
import type { CheguersRecord, JsonObject } from "../domain/model.js"
import type { CheguersError } from "../errors.js"
import { ValidationError } from "../errors.js"

export const shapeRecordRows = async (
  tx: SqlExecutor,
  rows: ReadonlyArray<SqlRow>
): Promise<ReadonlyArray<CheguersRecord>> => {
  const result: Array<CheguersRecord> = []
  for (const row of rows) {
    const data = JSON.parse(row.data as string) as JsonObject
    const labelRows = await tx.all(
      `SELECT l.name AS name FROM record_labels rl JOIN labels l ON l.id = rl.label_id
       WHERE rl.record_id = ? ORDER BY l.name`,
      row.id as number
    )
    result.push({
      id: asRecordId(row.public_id as string),
      data,
      labels: labelRows.map((r) => r.name as LabelName),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    })
  }
  return result
}

export const executeCompiled = (
  tx: SqlExecutor,
  sql: string,
  params: ReadonlyArray<string | number | boolean | null>
): Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => tx.all(sql, ...params) as Promise<ReadonlyArray<SqlRow>>,
      catch: (cause): CheguersError =>
        new ValidationError({ message: "query execution failed", cause })
    })
    return yield* Effect.promise(() => shapeRecordRows(tx, rows))
  })
