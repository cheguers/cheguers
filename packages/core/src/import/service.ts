import { Context, Effect, Layer } from "effect"
import { ValidationError, type CheguersError } from "../errors.js"
import {
  generateRecordId,
  generateRelationshipId,
  type LabelName
} from "../domain/ids.js"
import type { JsonObject } from "../domain/model.js"
import { TursoAdapter } from "../database/turso.js"
import type { SqlExecutor } from "../database/sql.js"
import { nowIso } from "../database/sql.js"
import { ensureLabelLink, insertRecord } from "../database/repository.js"
import { recordCatalogChanges } from "../schema/infer.js"
import { normalizeNestedJson, type NormalizedImport } from "./normalizer.js"

export interface ImportOptions {
  readonly rootLabels?: ReadonlyArray<string>
}

export interface ImportResult {
  readonly rootId: string
  readonly recordsCreated: number
  readonly labelsLinked: number
  readonly relationshipsCreated: number
  readonly idsByLocalId: Readonly<Record<string, string>>
}

export class NestedImportService extends Context.Service<
  NestedImportService,
  NestedImportShape
>()("cheguers/db/NestedImportService") {}

export interface NestedImportShape {
  readonly run: (
    input: JsonObject,
    options?: ImportOptions
  ) => Effect.Effect<ImportResult, CheguersError>
}

export const executePlan = (
  tx: SqlExecutor,
  plan: NormalizedImport
): Effect.Effect<ImportResult, CheguersError> =>
  Effect.gen(function* () {
    const timestamp = nowIso()
    const publicIds = new Map<string, string>()
    const internalIds = new Map<string, number>()
    let labelCount = 0

    for (const spec of plan.records) {
      const publicId = generateRecordId()
      const numericId = yield* insertRecord(tx, {
        publicId,
        data: spec.data,
        timestamp
      })
      publicIds.set(spec.localId, publicId)
      internalIds.set(spec.localId, numericId)
    }

    let relationshipCount = 0
    for (const spec of plan.records) {
      const numericId = internalIds.get(spec.localId)!
      if (numericId === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `internal import error: missing record ${spec.localId}`
          })
        )
      }
      for (const label of spec.labels) {
        yield* ensureLabelLink(tx, numericId, label as LabelName)
        labelCount++
      }
      yield* Effect.tryPromise({
        try: () => recordCatalogChanges(tx, spec.labels, spec.data, timestamp),
        catch: (cause): CheguersError =>
          new ValidationError({ message: "schema catalog update failed", cause })
      })
      if (
        spec.parentLocalId !== undefined &&
        spec.relationshipType !== undefined
      ) {
        const parentInternalId = internalIds.get(spec.parentLocalId)
        if (parentInternalId === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              message: `internal import error: missing parent ${spec.parentLocalId}`
            })
          )
        }
        yield* Effect.tryPromise({
          try: () =>
            tx.run(
              `INSERT INTO relationships (public_id, source_id, target_id, type, properties, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              generateRelationshipId(),
              parentInternalId,
              numericId,
              spec.relationshipType,
              "{}",
              timestamp
            ).then(() => undefined),
          catch: (cause): CheguersError =>
            new ValidationError({
              message: `failed to create import relationship ${spec.relationshipType}`,
              cause
            })
        })
        relationshipCount++
      }
    }

    return {
      rootId: publicIds.get(plan.rootLocalId)!,
      recordsCreated: plan.records.length,
      labelsLinked: labelCount,
      relationshipsCreated: relationshipCount,
      idsByLocalId: Object.fromEntries(publicIds)
    }
  })

export const makeNestedImportService: Effect.Effect<
  NestedImportShape,
  never,
  TursoAdapter
> = Effect.gen(function* () {
  const adapter = yield* TursoAdapter

  return {
    run: (input, options) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          let plan: NormalizedImport
          try {
            plan = normalizeNestedJson(input, options)
          } catch (error) {
            return yield* Effect.fail(
              error instanceof ValidationError
                ? error
                : new ValidationError({
                    message: "nested import normalization failed",
                    cause: error
                  })
            )
          }
          return yield* executePlan(tx, plan)
        })
      )
  }
})

export const nestedImportLayer = Layer.effect(
  NestedImportService,
  makeNestedImportService
)
