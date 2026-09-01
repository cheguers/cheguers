import { Context, Effect, Layer } from "effect";
import { ValidationError, type CheguersError } from "../errors.js";
import type { LabelName } from "../domain/ids.js";
import { TursoAdapter } from "../database/turso.js";
import { readNumberColumn, readStringColumn } from "../database/row-parsers.js";
import type { SqlExecutor, SqlRow } from "../database/sql.js";
import type { InferredType } from "./infer.js";

export interface SchemaEntry {
  readonly label: string;
  readonly property: string;
  readonly inferredType: InferredType;
  readonly observations: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface SchemaApi {
  readonly introspect: (options?: {
    readonly label?: string;
  }) => Effect.Effect<ReadonlyArray<SchemaEntry>, CheguersError>;
}

const isInferredType = (value: string): value is InferredType =>
  value === "string" ||
  value === "number" ||
  value === "boolean" ||
  value === "null" ||
  value === "datetime";

const parseSchemaRow = (row: SqlRow): SchemaEntry => {
  const inferredType = readStringColumn(row, "inferred_type");
  if (!isInferredType(inferredType)) {
    throw new ValidationError({ message: `invalid inferred type: ${inferredType}` });
  }
  return {
    label: readStringColumn(row, "label"),
    property: readStringColumn(row, "property"),
    inferredType,
    observations: readNumberColumn(row, "observations"),
    firstSeen: readStringColumn(row, "first_seen"),
    lastSeen: readStringColumn(row, "last_seen"),
  };
};

const introspectInTx = (
  tx: SqlExecutor,
  label: string | undefined,
): Effect.Effect<ReadonlyArray<SchemaEntry>, CheguersError> =>
  Effect.gen(function* () {
    if (label !== undefined && !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(label)) {
      return yield* Effect.fail(new ValidationError({ message: `invalid label filter: ${label}` }));
    }
    const rows = yield* Effect.tryPromise({
      try: () =>
        label === undefined
          ? tx.all(
              `SELECT label, property, inferred_type, observations, first_seen, last_seen
               FROM schema_catalog ORDER BY label, property`,
            )
          : tx.all(
              `SELECT label, property, inferred_type, observations, first_seen, last_seen
               FROM schema_catalog WHERE label = ? ORDER BY label, property`,
              label,
            ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "schema introspection failed", cause }),
    });
    return rows.map(parseSchemaRow);
  });

export class SchemaService extends Context.Service<SchemaService, SchemaApi>()(
  "cheguers/db/SchemaService",
) {}

export const makeSchemaService: Effect.Effect<SchemaApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;
    return {
      introspect: (options) => adapter.transact((tx) => introspectInTx(tx, options?.label)),
    };
  },
);

export const schemaLayer = Layer.effect(SchemaService, makeSchemaService);

// Re-exported for service wiring; keeps the LabelName import meaningful for consumers.
export type { LabelName };
