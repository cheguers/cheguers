import { Context, Effect, Layer } from "effect";
import { TursoAdapter } from "../database/turso.js";
import type { CheguersError } from "../errors.js";
import type { CheguersRecord } from "../domain/model.js";
import { compileRecordQueryAst } from "./compiler/index.js";
import { executeCompiled } from "./executor.js";
import { parseRecordQuery } from "./parser.js";
import type { RecordQuery } from "./types.js";

export interface QueryApi {
  readonly find: (
    query: RecordQuery,
  ) => Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError>;
}

export class QueryService extends Context.Service<QueryService, QueryApi>()(
  "cheguers/db/QueryService",
) {}

export const makeQueryService: Effect.Effect<QueryApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;
    return {
      find: (query) =>
        adapter.transact((tx) =>
          Effect.gen(function* () {
            const ast = yield* parseRecordQuery(query);
            const compiled = compileRecordQueryAst(ast);
            return yield* executeCompiled(tx, compiled.sql, compiled.params);
          }),
        ),
    };
  },
);

export const queryLayer = Layer.effect(QueryService, makeQueryService);
