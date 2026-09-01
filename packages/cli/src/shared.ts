import { readFileSync } from "node:fs";
import { Console, Effect } from "effect";
import { Argument, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import {
  isJsonArray,
  isPlainObject,
  isStringValue,
  open,
  parseJsonObject,
  parseJsonValue,
  type CheguersDBHandle,
  type CheguersError,
  type CreateRecordInput,
  type HybridQuery,
  type JsonObject,
  type JsonValue,
  type OrderBy,
  type TraversalSpec,
  type VectorMetric,
  type WhereExpression,
} from "@cheguers/core";

export const dbPath = Argument.file("db", { mustExist: false }).pipe(
  Argument.withDescription("Path to the CheguersDB database file"),
);

export const labelsFlag = Flag.string("labels").pipe(
  Flag.withDescription("Comma-separated label names"),
  Flag.optional,
);

export const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Label name filter"),
  Flag.optional,
);

export const whereFlag = Flag.string("where").pipe(
  Flag.withDescription("JSON where expression"),
  Flag.optional,
);

export const namespaceFlag = Flag.string("namespace").pipe(
  Flag.withDescription("Vector namespace"),
  Flag.optional,
);

export const metricFlag = Flag.choice("metric", ["cosine", "l2"] as const).pipe(
  Flag.withDescription("Vector distance metric"),
  Flag.withDefault("cosine" satisfies VectorMetric),
);

export const directionFlag = Flag.choice("direction", [
  "outgoing",
  "incoming",
  "both",
] as const).pipe(
  Flag.withDescription("Traversal direction"),
  Flag.withDefault("outgoing" satisfies TraversalSpec["direction"]),
);

export const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("Maximum number of results"),
  Flag.optional,
);

export const offsetFlag = Flag.integer("offset").pipe(
  Flag.withDescription("Result offset"),
  Flag.optional,
);

export const orderFlag = Flag.string("order").pipe(
  Flag.withDescription("Order clauses as property:asc,property2:desc"),
  Flag.optional,
);

export const typesFlag = Flag.string("types").pipe(
  Flag.withDescription("Comma-separated relationship types"),
  Flag.optional,
);

export const startFlag = Flag.string("start").pipe(
  Flag.withDescription("Comma-separated start record ids"),
  Flag.optional,
);

export const minDepthFlag = Flag.integer("min-depth").pipe(
  Flag.withDescription("Minimum traversal depth"),
  Flag.optional,
);

export const maxDepthFlag = Flag.integer("max-depth").pipe(
  Flag.withDescription("Maximum traversal depth"),
  Flag.optional,
);

export const pathsFlag = Flag.boolean("paths").pipe(
  Flag.withDescription("Include traversal paths in output"),
  Flag.withDefault(false),
);

export const vectorFlag = Flag.string("vector").pipe(
  Flag.withDescription("Comma-separated vector components"),
  Flag.optional,
);

export const topKFlag = Flag.integer("top-k").pipe(
  Flag.withDescription("Vector search top-k"),
  Flag.optional,
);

export const maxDistanceFlag = Flag.float("max-distance").pipe(
  Flag.withDescription("Maximum vector distance"),
  Flag.optional,
);

export const seedsFlag = Flag.integer("seeds").pipe(
  Flag.withDescription("Hybrid vector seed count"),
  Flag.optional,
);

export const expandDepthFlag = Flag.integer("expand-depth").pipe(
  Flag.withDescription("Hybrid graph expansion depth (0-3)"),
  Flag.optional,
);

export const topNFlag = Flag.integer("top-n").pipe(
  Flag.withDescription("Hybrid final top-n"),
  Flag.optional,
);

export const provenanceFlag = Flag.boolean("provenance").pipe(
  Flag.withDescription("Include hybrid provenance in output"),
  Flag.withDefault(false),
);

export const propsFlag = Flag.string("props").pipe(
  Flag.withDescription("Relationship properties as JSON"),
  Flag.optional,
);

export const splitList = (value: string | undefined): ReadonlyArray<string> | undefined =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

export const assignIfDefined = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void => {
  if (value !== undefined) {
    target[key] = value;
  }
};

const cliError = (message: string, cause?: unknown): CliError.UserError =>
  new CliError.UserError({
    userMessage: JSON.stringify({ error: message }, null, 2),
    cause,
  });

export const readJsonValueFile = (file: string, message: string): JsonValue => {
  try {
    return parseJsonValue(JSON.parse(readFileSync(file, "utf8")), message);
  } catch (cause) {
    throw cliError(`cannot read JSON file ${file}: ${String(cause)}`, cause);
  }
};

export const readJsonObjectFile = (file: string, message: string): JsonObject => {
  const value = readJsonValueFile(file, message);
  if (!isPlainObject(value)) {
    throw cliError(message);
  }
  return parseJsonObject(value, message);
};

export const parseJsonFlag = (value: string | undefined, flag: string): JsonObject | undefined => {
  if (value === undefined) return undefined;
  try {
    return parseJsonObject(JSON.parse(value), `--${flag} is not valid JSON`);
  } catch (cause) {
    throw cliError(`--${flag} is not valid JSON`, cause);
  }
};

export const parseWhereFlag = (value: string | undefined): WhereExpression | undefined => {
  if (value === undefined) return undefined;
  const parsed = parseJsonValue(JSON.parse(value), "--where is not valid JSON");
  if (!isPlainObject(parsed)) {
    throw cliError("--where must be a JSON object");
  }
  // SAFETY: CLI forwards JSON to the query parser, which validates operator shapes.
  return parsed as WhereExpression;
};

export const parseOrderFlag = (value: string | undefined): ReadonlyArray<OrderBy> | undefined =>
  value === undefined
    ? undefined
    : value.split(",").map((entry) => {
        const [property, direction] = entry.split(":");
        return {
          property: (property ?? "").trim(),
          direction: direction?.trim() === "desc" ? "desc" : "asc",
        };
      });

export const parseVectorFlag = (value: string | undefined, flag: string): ReadonlyArray<number> => {
  if (value === undefined) {
    throw cliError(`missing --${flag}`);
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    throw cliError(`--${flag} must be a comma-separated list of finite numbers`);
  }
  return parts;
};

const parseCreateRecordInput = (value: JsonValue, index: number): CreateRecordInput => {
  const obj = parseJsonObject(value, `bulk record ${index} must be an object`);
  const data = parseJsonObject(obj.data, `bulk record ${index}: data must be an object`);
  let id: string | undefined;
  if (obj.id !== undefined) {
    if (!isStringValue(obj.id)) {
      throw cliError(`bulk record ${index}: id must be a string`);
    }
    id = obj.id;
  }
  let labels: string[] | undefined;
  if (obj.labels !== undefined) {
    if (!isJsonArray(obj.labels)) {
      throw cliError(`bulk record ${index}: labels must be an array`);
    }
    labels = [];
    for (const label of obj.labels) {
      if (!isStringValue(label)) {
        throw cliError(`bulk record ${index}: labels must be strings`);
      }
      labels.push(label);
    }
  }
  if (id !== undefined && labels !== undefined) return { data, id, labels };
  if (id !== undefined) return { data, id };
  if (labels !== undefined) return { data, labels };
  return { data };
};

export const parseCreateRecordInputs = (value: JsonValue): ReadonlyArray<CreateRecordInput> => {
  if (!isJsonArray(value)) {
    throw cliError("bulk file must be a JSON array of {data, labels}");
  }
  return value.map((entry, index) =>
    parseCreateRecordInput(parseJsonValue(entry, `bulk record ${index} must be valid JSON`), index),
  );
};

type TraversalSpecDraft = {
  startIds: string[];
  direction: TraversalSpec["direction"];
  relationshipTypes?: string[];
  minDepth?: number;
  maxDepth?: number;
  limit?: number;
  includePaths?: boolean;
};

export const buildTraversalSpec = (input: {
  start: string | undefined;
  direction: TraversalSpec["direction"];
  types: string | undefined;
  minDepth: number | undefined;
  maxDepth: number | undefined;
  limit: number | undefined;
  paths: boolean;
}): TraversalSpec => {
  const startIds = splitList(input.start);
  if (startIds === undefined || startIds.length === 0) {
    throw cliError("traverse requires --start id1,id2");
  }
  const spec: TraversalSpecDraft = {
    startIds: [...startIds],
    direction: input.direction,
  };
  if (input.types !== undefined) {
    const relationshipTypes = splitList(input.types);
    if (relationshipTypes !== undefined) {
      spec.relationshipTypes = [...relationshipTypes];
    }
  }
  assignIfDefined(spec, "minDepth", input.minDepth);
  assignIfDefined(spec, "maxDepth", input.maxDepth);
  assignIfDefined(spec, "limit", input.limit);
  if (input.paths) {
    spec.includePaths = true;
  }
  // SAFETY: optional fields are added only when defined; draft shape matches TraversalSpec.
  return spec as TraversalSpec;
};

type HybridSearchDraft = {
  vector: ReadonlyArray<number>;
  metric: VectorMetric;
  namespace?: string;
  labels?: ReadonlyArray<string>;
  where?: WhereExpression;
  seeds?: number;
  expandDepth?: number;
  direction?: HybridQuery["direction"];
  relationshipTypes?: ReadonlyArray<string>;
  topN?: number;
  includeProvenance?: boolean;
};

export const buildHybridQuery = (input: {
  vector: ReadonlyArray<number>;
  metric: VectorMetric;
  namespace: string | undefined;
  labels: string | undefined;
  where: string | undefined;
  seeds: number | undefined;
  expandDepth: number | undefined;
  direction: HybridQuery["direction"];
  types: string | undefined;
  topN: number | undefined;
  provenance: boolean;
}): HybridQuery => {
  const query: HybridSearchDraft = {
    vector: input.vector,
    metric: input.metric,
  };
  assignIfDefined(query, "namespace", input.namespace);
  assignIfDefined(query, "labels", splitList(input.labels));
  assignIfDefined(query, "where", parseWhereFlag(input.where));
  assignIfDefined(query, "seeds", input.seeds);
  assignIfDefined(query, "expandDepth", input.expandDepth);
  if (input.direction !== "outgoing") {
    query.direction = input.direction;
  }
  assignIfDefined(query, "relationshipTypes", splitList(input.types));
  assignIfDefined(query, "topN", input.topN);
  if (input.provenance) {
    query.includeProvenance = true;
  }
  // SAFETY: optional fields are added only when defined; draft shape matches HybridQuery.
  return query as HybridQuery;
};

const mapCheguersError = (error: CheguersError): CliError.UserError =>
  new CliError.UserError({
    userMessage: JSON.stringify({ error }, null, 2),
    cause: error,
  });

export const withDb = <A>(
  path: string,
  fn: (db: CheguersDBHandle) => Effect.Effect<A, CheguersError>,
): Effect.Effect<A, CheguersError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* open(path);
      yield* Effect.addFinalizer(() => db.close.pipe(Effect.ignore));
      return yield* fn(db);
    }),
  );

export const printJson = <A>(value: A): Effect.Effect<void> =>
  Console.log(JSON.stringify(value, null, 2));

export const runDb =
  (path: string) =>
  <A>(
    fn: (db: CheguersDBHandle) => Effect.Effect<A, CheguersError>,
  ): Effect.Effect<void, CliError.UserError> =>
    withDb(path, fn).pipe(Effect.tap(printJson), Effect.asVoid, Effect.mapError(mapCheguersError));
