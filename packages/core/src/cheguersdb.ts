import { Effect } from "effect"
import { makeRecordsService, type RecordsShape } from "./records/service.js"
import {
  makeRelationshipsService,
  type RelationshipsShape
} from "./relationships/service.js"
import { makeTraversalService, type TraversalShape } from "./relationships/traversal.js"
import {
  makeNestedImportService,
  type NestedImportShape
} from "./import/service.js"
import { makeSchemaService, type SchemaShape } from "./schema/service.js"
import { makeQueryService, type QueryShape } from "./query/service.js"
import { makeVectorService, type VectorShape } from "./vector/service.js"
import { makeHybridService, type HybridShape } from "./hybrid/service.js"
import {
  makeTransactionService,
  makeBulkService,
  type TransactionShape,
  type BulkShape
} from "./transactions/service.js"
import { TursoAdapter, makeTursoAdapter } from "./database/turso.js"
import type { CheguersError } from "./errors.js"

export interface CheguersDBShape {
  readonly records: RecordsShape
  readonly relationships: RelationshipsShape
  readonly traversal: TraversalShape
  readonly imports: NestedImportShape
  readonly schema: SchemaShape
  readonly query: QueryShape
  readonly vectors: VectorShape
  readonly hybrid: HybridShape
  readonly transaction: TransactionShape["run"]
  readonly bulk: BulkShape
}

export interface CheguersDBHandle extends CheguersDBShape {
  readonly close: Effect.Effect<void, CheguersError>
}

export const open = (path: string): Effect.Effect<CheguersDBHandle, CheguersError> =>
  Effect.gen(function* () {
    const adapter = yield* makeTursoAdapter(path)
    const records = yield* makeRecordsService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const relationships = yield* makeRelationshipsService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const traversal = yield* makeTraversalService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const imports = yield* makeNestedImportService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const schema = yield* makeSchemaService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const query = yield* makeQueryService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const vectors = yield* makeVectorService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const hybrid = yield* makeHybridService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const transactions = yield* makeTransactionService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    const bulk = yield* makeBulkService.pipe(
      Effect.provideService(TursoAdapter, adapter)
    )
    return {
      records,
      relationships,
      traversal,
      imports,
      schema,
      query,
      vectors,
      hybrid,
      transaction: transactions.run,
      bulk,
      close: adapter.close
    }
  })
