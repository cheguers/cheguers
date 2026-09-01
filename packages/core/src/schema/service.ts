import { Context, Effect, Layer } from "effect"
import { ValidationError, type CheguersError } from "../errors.js"
import type { LabelName } from "../domain/ids.js"
import { TursoAdapter } from "../database/turso.js"
import type { SqlExecutor, SqlRow } from "../database/sql.js"
import type { InferredType } from "./infer.js"

export interface SchemaEntry {
  readonly label: string
  readonly property: string
  readonly inferredType: InferredType
  readonly observations: number
  readonly firstSeen: string
  readonly lastSeen: string
}

export interface SchemaShape {
  readonly introspect: (
    options?: { readonly label?: string }
  ) => Effect.Effect<ReadonlyArray<SchemaEntry>, CheguersError>
}

const mapRow = (row: SqlRow): SchemaEntry => ({
  label: row.label as string,
  property: row.property as string,
  inferredType: row.inferred_type as InferredType,
  observations: Number(row.observations),
  firstSeen: row.first_seen as string,
  lastSeen: row.last_seen as string
})

const introspectInTx = (
  tx: SqlExecutor,
  label: string | undefined
): Effect.Effect<ReadonlyArray<SchemaEntry>, CheguersError> =>
  Effect.gen(function* () {
    if (label !== undefined && !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(label)) {
      return yield* Effect.fail(
        new ValidationError({ message: `invalid label filter: ${label}` })
      )
    }
    const rows = yield* Effect.tryPromise({
      try: () =>
        label === undefined
          ? tx.all(
              `SELECT label, property, inferred_type, observations, first_seen, last_seen
               FROM schema_catalog ORDER BY label, property`
            )
          : tx.all(
              `SELECT label, property, inferred_type, observations, first_seen, last_seen
               FROM schema_catalog WHERE label = ? ORDER BY label, property`,
              label
            ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "schema introspection failed", cause })
    }) as Effect.Effect<ReadonlyArray<SqlRow>, CheguersError>
    return rows.map(mapRow)
  })

export class SchemaService extends Context.Service<SchemaService, SchemaShape>()(
  "cheguers/db/SchemaService"
) {}

export const makeSchemaService: Effect.Effect<
  SchemaShape,
  never,
  TursoAdapter
> = Effect.gen(function* () {
  const adapter = yield* TursoAdapter
  return {
    introspect: (options) =>
      adapter.transact((tx) => introspectInTx(tx, options?.label))
  }
})

export const schemaLayer = Layer.effect(SchemaService, makeSchemaService)

// Re-exported for service wiring; keeps the LabelName import meaningful for consumers.
export type { LabelName }
