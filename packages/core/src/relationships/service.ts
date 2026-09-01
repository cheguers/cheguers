import { Context, Effect, Layer } from "effect"
import {
  NotFoundError,
  ValidationError,
  type CheguersError
} from "../errors.js"
import {
  asRecordId,
  asRelationshipId,
  generateRelationshipId,
  isRelationshipId,
  isRelationshipType,
  type RelationshipType
} from "../domain/ids.js"
import type {
  CheguersRelationship,
  CreateRelationshipInput,
  JsonObject
} from "../domain/model.js"
import { TursoAdapter } from "../database/turso.js"
import type { SqlExecutor, SqlRow } from "../database/sql.js"
import { nowIso } from "../database/sql.js"

const REL_COLUMNS = `rel.public_id AS public_id, rel.type AS type,
  src.public_id AS source_public_id, tgt.public_id AS target_public_id,
  rel.properties AS properties, rel.created_at AS created_at`

const mapRow = (row: SqlRow): CheguersRelationship => ({
  id: asRelationshipId(row.public_id as string),
  type: row.type as RelationshipType,
  sourceId: asRecordId(row.source_public_id as string),
  targetId: asRecordId(row.target_public_id as string),
  properties: JSON.parse(row.properties as string) as JsonObject,
  createdAt: row.created_at as string
})

const rowsToRels = (
  rows: ReadonlyArray<SqlRow>
): ReadonlyArray<CheguersRelationship> => rows.map(mapRow)

const parseRelType = (
  type: string
): Effect.Effect<RelationshipType, ValidationError> =>
  isRelationshipType(type)
    ? Effect.succeed(type)
    : Effect.fail(
        new ValidationError({ message: `invalid relationship type: ${type}` })
      )

const checkEndpointsExist = (
  tx: SqlExecutor,
  sourcePublicId: string,
  targetPublicId: string
): Effect.Effect<void, CheguersError> =>
  Effect.gen(function* () {
    const count = yield* Effect.tryPromise({
      try: () =>
        tx.get(
          "SELECT COUNT(*) AS n FROM records WHERE public_id IN (?, ?)",
          sourcePublicId,
          targetPublicId
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "endpoint lookup failed", cause })
    })
    const distinct =
      count !== undefined && Number(count.n) === (sourcePublicId === targetPublicId ? 1 : 2)
    if (!distinct || sourcePublicId === targetPublicId) {
      return yield* Effect.fail(
        new ValidationError({
          message:
            "one or both relationship endpoints do not exist or are identical"
        })
      )
    }
  })

export class RelationshipsService extends Context.Service<
  RelationshipsService,
  RelationshipsShape
>()("cheguers/db/RelationshipsService") {}

export interface RelationshipsShape {
  readonly create: (
    input: CreateRelationshipInput
  ) => Effect.Effect<CheguersRelationship, CheguersError>
  readonly get: (id: string) => Effect.Effect<CheguersRelationship, CheguersError>
  readonly delete: (id: string) => Effect.Effect<void, CheguersError>
  readonly outgoing: (
    recordId: string,
    type?: string
  ) => Effect.Effect<ReadonlyArray<CheguersRelationship>, CheguersError>
  readonly incoming: (
    recordId: string,
    type?: string
  ) => Effect.Effect<ReadonlyArray<CheguersRelationship>, CheguersError>
}

export const createRelationshipInTx = (
  tx: SqlExecutor,
  input: CreateRelationshipInput
): Effect.Effect<CheguersRelationship, CheguersError> =>
  Effect.gen(function* () {
    const type = yield* parseRelType(input.type)
    let publicId: string
    if (input.id === undefined) {
      publicId = generateRelationshipId()
    } else if (!isRelationshipId(input.id)) {
      return yield* Effect.fail(
        new ValidationError({ message: `invalid relationship id: ${input.id}` })
      )
    } else {
      publicId = input.id
    }
    const properties = input.properties ?? {}

    yield* checkEndpointsExist(tx, input.sourceId, input.targetId)

    const source = yield* Effect.tryPromise({
      try: () =>
        tx.get("SELECT id FROM records WHERE public_id = ?", input.sourceId),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "source lookup failed", cause })
    })
    const target = yield* Effect.tryPromise({
      try: () =>
        tx.get("SELECT id FROM records WHERE public_id = ?", input.targetId),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "target lookup failed", cause })
    })
    if (source === undefined || target === undefined) {
      return yield* Effect.fail(
        new ValidationError({ message: "relationship endpoints do not exist" })
      )
    }

    const timestamp = nowIso()
    yield* Effect.tryPromise({
      try: () =>
        tx.run(
          `INSERT INTO relationships (public_id, source_id, target_id, type, properties, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          publicId,
          source.id as number,
          target.id as number,
          type,
          JSON.stringify(properties),
          timestamp
        ).then(() => undefined),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "failed to create relationship", cause })
    })

    return {
      id: asRelationshipId(publicId),
      type,
      sourceId: asRecordId(input.sourceId),
      targetId: asRecordId(input.targetId),
      properties,
      createdAt: timestamp
    } satisfies CheguersRelationship
  })

export const deleteRelationshipInTx = (
  tx: SqlExecutor,
  rawId: string
): Effect.Effect<void, CheguersError> =>
  Effect.gen(function* () {
    const deleted = yield* Effect.tryPromise({
      try: () => tx.run("DELETE FROM relationships WHERE public_id = ?", rawId),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "delete relationship failed", cause })
    })
    if (deleted.changes === 0) {
      return yield* Effect.fail(new NotFoundError({ kind: "relationship", id: rawId }))
    }
  })

export const makeRelationshipsService: Effect.Effect<
  RelationshipsShape,
  never,
  TursoAdapter
> = Effect.gen(function* () {
  const adapter = yield* TursoAdapter

  const selectFor = (
    selfColumn: "source_id" | "target_id",
    type?: RelationshipType
  ): ReadonlyArray<unknown> => {
    const join = `FROM relationships rel
       JOIN records me ON me.id = rel.${selfColumn}
       JOIN records src ON src.id = rel.source_id
       JOIN records tgt ON tgt.id = rel.target_id`
    const sql =
      type === undefined
        ? `SELECT ${REL_COLUMNS}
           ${join}
           WHERE me.public_id = ?
           ORDER BY rel.public_id`
        : `SELECT ${REL_COLUMNS}
           ${join}
           WHERE me.public_id = ? AND rel.type = ?
           ORDER BY rel.public_id`
    return [sql]
  }

  const queryIncident = (
    direction: "outgoing" | "incoming",
    recordId: string,
    rawType: string | undefined
  ): Effect.Effect<ReadonlyArray<CheguersRelationship>, CheguersError> =>
    adapter.transact((tx) =>
      Effect.gen(function* () {
        let type: RelationshipType | undefined
        if (rawType !== undefined) {
          type = yield* parseRelType(rawType)
        }
        const [sql] = selectFor(
          direction === "outgoing" ? "source_id" : "target_id",
          type
        ) as [string]
        const params: Array<string> = [recordId]
        if (type !== undefined) params.push(type)
        const rows = yield* Effect.tryPromise({
          try: () => tx.all(sql, ...params).then((rs) => rs as ReadonlyArray<SqlRow>),
          catch: (cause): CheguersError =>
            new ValidationError({ message: `${direction} query failed`, cause })
        })
        return rowsToRels(rows)
      })
    )

  return {
    create: (input) =>
      adapter.transact((tx) => createRelationshipInTx(tx, input)),

    get: (rawId) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          const row = yield* Effect.tryPromise({
            try: () =>
              tx.get(`SELECT ${REL_COLUMNS}
                      FROM relationships rel
                      JOIN records src ON src.id = rel.source_id
                      JOIN records tgt ON tgt.id = rel.target_id
                      WHERE rel.public_id = ?`, rawId),
            catch: (cause): CheguersError =>
              new ValidationError({ message: "relationship lookup failed", cause })
          })
          if (row === undefined) {
            return yield* Effect.fail(new NotFoundError({ kind: "relationship", id: rawId }))
          }
          return mapRow(row)
        })
      ),

    delete: (rawId) =>
      adapter.transact((tx) => deleteRelationshipInTx(tx, rawId)),

    outgoing: (recordId, type) => queryIncident("outgoing", recordId, type),

    incoming: (recordId, type) => queryIncident("incoming", recordId, type)
  }
})

export const relationshipsLayer = Layer.effect(
  RelationshipsService,
  makeRelationshipsService
)
