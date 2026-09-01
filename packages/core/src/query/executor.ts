import { Effect } from "effect";
import { hydrateRecordsFromRows } from "../database/row-parsers.js";
import type { SqlExecutor } from "../database/sql.js";
import type { CheguersRecord } from "../domain/model.js";
import type { CheguersError } from "../errors.js";
import { ValidationError } from "../errors.js";

export { hydrateRecordsFromRows } from "../database/row-parsers.js";

export const executeCompiled = (
  tx: SqlExecutor,
  sql: string,
  params: ReadonlyArray<string | number | boolean | null>,
): Effect.Effect<ReadonlyArray<CheguersRecord>, CheguersError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => tx.all(sql, ...params),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "query execution failed", cause }),
    });
    return yield* Effect.promise(() => hydrateRecordsFromRows(tx, rows));
  });
