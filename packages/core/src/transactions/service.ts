import { Context, Effect, Layer } from "effect"
import {
  NotFoundError,
  ValidationError,
  type CheguersError
} from "../errors.js"
import type {
  CheguersRecord,
  CheguersRelationship,
  CreateRecordInput,
  CreateRelationshipInput,
  UpdateRecordInput,
  UpsertVectorInput
} from "../domain/model.js"
import { TursoAdapter } from "../database/turso.js"
import type { SqlExecutor } from "../database/sql.js"
import { deleteDependentsAndRecord } from "../database/repository.js"
import {
  createRecordInTx,
  deleteRecordInTx,
  updateRecordInTx
} from "../records/service.js"
import {
  createRelationshipInTx,
  deleteRelationshipInTx
} from "../relationships/service.js"
import { deleteVectorInTx, upsertVectorInTx } from "../vector/service.js"

/**
 * Mutation operations scoped to one explicit transaction. Every operation here
 * shares the caller's single underlying Turso transaction so multi-step writes
 * commit or roll back as a unit.
 */
export interface TransactionScope {
  readonly records: {
    readonly create: (input: CreateRecordInput) => Effect.Effect<CheguersRecord, CheguersError>
    readonly     update: (id: string, input: UpdateRecordInput) => Effect.Effect<CheguersRecord, CheguersError>
    readonly delete: (id: string) => Effect.Effect<void, CheguersError>
  }
  readonly relationships: {
    readonly create: (input: CreateRelationshipInput) => Effect.Effect<CheguersRelationship, CheguersError>
    readonly remove: (id: string) => Effect.Effect<void, CheguersError>
  }
  readonly vectors: {
    readonly upsert: (input: UpsertVectorInput) => Effect.Effect<unknown, CheguersError>
    readonly remove: (recordId: string, namespace?: string) => Effect.Effect<void, CheguersError>
  }
}

const scopedOps = (tx: SqlExecutor): TransactionScope => ({
  records: {
    create: (input) => createRecordInTx(tx, input),
    update: (id, input) => updateRecordInTx(tx, id, input),
    delete: (id) => deleteRecordInTx(tx, id)
  },
  relationships: {
    create: (input) => createRelationshipInTx(tx, input),
    remove: (id) => deleteRelationshipInTx(tx, id)
  },
  vectors: {
    upsert: (input) => upsertVectorInTx(tx, input),
    remove: (recordId, namespace) => deleteVectorInTx(tx, recordId, namespace)
  }
})

export class TransactionService extends Context.Service<
  TransactionService,
  TransactionShape
>()("cheguers/db/TransactionService") {}

export interface TransactionShape {
  readonly run: <A>(
    body: (ops: TransactionScope) => Effect.Effect<A, CheguersError>
  ) => Effect.Effect<A, CheguersError>
}

export const makeTransactionService: Effect.Effect<
  TransactionShape,
  never,
  TursoAdapter
> = Effect.gen(function* () {
  const adapter = yield* TursoAdapter
  return {
    run: <A>(body: (ops: TransactionScope) => Effect.Effect<A, CheguersError>) =>
      adapter.transact((tx) => body(scopedOps(tx)))
  }
})

export const transactionLayer = Layer.effect(
  TransactionService,
  makeTransactionService
)

/**
 * Bulk operations match individual-operation semantics exactly: every item is
 * processed through the same tx-scoped mutation path, all inside one atomic
 * transaction, aborting on the first failure with no partial state.
 */
export class BulkService extends Context.Service<BulkService, BulkShape>()(
  "cheguers/db/BulkService"
) {}

export interface BulkDeleteResult {
  readonly deleted: number
}

export interface BulkShape {
  readonly createRecords: (
    inputs: ReadonlyArray<CreateRecordInput>
  ) => Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError>
  readonly createRelationships: (
    inputs: ReadonlyArray<CreateRelationshipInput>
  ) => Effect.Effect<ReadonlyArray<CheguersRelationship>, CheguersError>
  readonly upsertVectors: (
    inputs: ReadonlyArray<UpsertVectorInput>
  ) => Effect.Effect<void, CheguersError>
  readonly deleteRecords: (
    ids: ReadonlyArray<string>
  ) => Effect.Effect<BulkDeleteResult, CheguersError>
}

export const makeBulkService: Effect.Effect<
  BulkShape,
  never,
  TursoAdapter
> = Effect.gen(function* () {
  const adapter = yield* TursoAdapter

  return {
    createRecords: (inputs) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          if (!Array.isArray(inputs)) {
            return yield* Effect.fail(
              new ValidationError({ message: "inputs must be an array" })
            )
          }
          const created: Array<CheguersRecord> = []
          for (const input of inputs) {
            created.push(yield* createRecordInTx(tx, input))
          }
          return created
        })
      ),

    createRelationships: (inputs) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          if (!Array.isArray(inputs)) {
            return yield* Effect.fail(
              new ValidationError({ message: "inputs must be an array" })
            )
          }
          const created: Array<CheguersRelationship> = []
          for (const input of inputs) {
            created.push(yield* createRelationshipInTx(tx, input))
          }
          return created
        })
      ),

    upsertVectors: (inputs) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          if (!Array.isArray(inputs)) {
            return yield* Effect.fail(
              new ValidationError({ message: "inputs must be an array" })
            )
          }
          for (const input of inputs) {
            yield* upsertVectorInTx(tx, input)
          }
        })
      ),

    deleteRecords: (ids) =>
      adapter.transact((tx) =>
        Effect.gen(function* () {
          if (!Array.isArray(ids)) {
            return yield* Effect.fail(
              new ValidationError({ message: "ids must be an array" })
            )
          }
          let deleted = 0
          for (const id of ids) {
            deleted += yield* deleteDependentsAndRecordPublic(tx, id)
          }
          return { deleted }
        })
      )
  }
})

const deleteDependentsAndRecordPublic = (
  tx: SqlExecutor,
  publicId: string
): Effect.Effect<number, CheguersError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () => tx.get("SELECT id FROM records WHERE public_id = ?", publicId),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "record lookup failed", cause })
    })
    if (row === undefined) {
      return yield* Effect.fail(new NotFoundError({ kind: "record", id: publicId }))
    }
    return yield* deleteDependentsAndRecord(tx, row.id as number)
  })

export const bulkLayer = Layer.effect(BulkService, makeBulkService)
