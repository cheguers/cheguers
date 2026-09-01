import { Effect } from "effect";
import { makeRecordsService, type RecordsApi } from "./records/service.js";
import { makeRelationshipsService, type RelationshipsApi } from "./relationships/service.js";
import { makeTraversalService, type TraversalApi } from "./relationships/traversal.js";
import { makeNestedImportService, type ImportApi } from "./import/service.js";
import { makeSchemaService, type SchemaApi } from "./schema/service.js";
import { makeQueryService, type QueryApi } from "./query/service.js";
import { makeVectorService, type VectorApi } from "./vector/service.js";
import { makeHybridService, type HybridApi } from "./hybrid/service.js";
import {
  makeTransactionService,
  makeBulkService,
  type TransactionApi,
  type BulkApi,
} from "./transactions/service.js";
import { TursoAdapter, makeTursoAdapter } from "./database/turso.js";
import type { CheguersError } from "./errors.js";

export interface CheguersDBApi {
  readonly records: RecordsApi;
  readonly relationships: RelationshipsApi;
  readonly traversal: TraversalApi;
  readonly imports: ImportApi;
  readonly schema: SchemaApi;
  readonly query: QueryApi;
  readonly vectors: VectorApi;
  readonly hybrid: HybridApi;
  readonly transaction: TransactionApi["run"];
  readonly bulk: BulkApi;
}

export interface CheguersDBHandle extends CheguersDBApi {
  readonly close: Effect.Effect<void, CheguersError>;
}

export const open = (path: string): Effect.Effect<CheguersDBHandle, CheguersError> =>
  Effect.gen(function* () {
    const adapter = yield* makeTursoAdapter(path);
    const records = yield* makeRecordsService.pipe(Effect.provideService(TursoAdapter, adapter));
    const relationships = yield* makeRelationshipsService.pipe(
      Effect.provideService(TursoAdapter, adapter),
    );
    const traversal = yield* makeTraversalService.pipe(
      Effect.provideService(TursoAdapter, adapter),
    );
    const imports = yield* makeNestedImportService.pipe(
      Effect.provideService(TursoAdapter, adapter),
    );
    const schema = yield* makeSchemaService.pipe(Effect.provideService(TursoAdapter, adapter));
    const query = yield* makeQueryService.pipe(Effect.provideService(TursoAdapter, adapter));
    const vectors = yield* makeVectorService.pipe(Effect.provideService(TursoAdapter, adapter));
    const hybrid = yield* makeHybridService.pipe(Effect.provideService(TursoAdapter, adapter));
    const transactions = yield* makeTransactionService.pipe(
      Effect.provideService(TursoAdapter, adapter),
    );
    const bulk = yield* makeBulkService.pipe(Effect.provideService(TursoAdapter, adapter));
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
      close: adapter.close,
    };
  });
