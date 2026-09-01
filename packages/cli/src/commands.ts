import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { type CheguersDBHandle, type RecordQuery } from "@cheguers/core";
import {
  assignIfDefined,
  buildHybridQuery,
  buildTraversalSpec,
  dbPath,
  directionFlag,
  expandDepthFlag,
  labelFlag,
  labelsFlag,
  limitFlag,
  maxDistanceFlag,
  metricFlag,
  minDepthFlag,
  maxDepthFlag,
  namespaceFlag,
  offsetFlag,
  orderFlag,
  parseCreateRecordInputs,
  parseJsonFlag,
  parseOrderFlag,
  parseVectorFlag,
  parseWhereFlag,
  pathsFlag,
  propsFlag,
  provenanceFlag,
  readJsonObjectFile,
  readJsonValueFile,
  runDb,
  seedsFlag,
  splitList,
  startFlag,
  topKFlag,
  topNFlag,
  typesFlag,
  vectorFlag,
  whereFlag,
} from "./shared.js";

const importFile = Argument.file("file", { mustExist: true }).pipe(
  Argument.withDescription("JSON file to import"),
);

export const importCmd = Command.make(
  "import",
  {
    db: dbPath,
    file: importFile,
    labels: labelsFlag,
  },
  Effect.fn(function* ({ db, file, labels }) {
    const input = readJsonObjectFile(file, "import file must contain a JSON object");
    const labelList = Option.getOrUndefined(labels);
    const rootLabels = labelList === undefined ? undefined : splitList(labelList);
    const options = rootLabels === undefined ? undefined : { rootLabels };
    yield* runDb(db)((database) => database.imports.run(input, options));
  }),
).pipe(Command.withDescription("Nested JSON -> graph (atomic)"));

export const bulk = Command.make(
  "bulk",
  {
    db: dbPath,
    file: importFile,
  },
  Effect.fn(function* ({ db, file }) {
    const input = readJsonValueFile(file, "bulk file must be valid JSON");
    const records = parseCreateRecordInputs(input);
    yield* runDb(db)((database) => database.bulk.createRecords(records));
  }),
).pipe(Command.withDescription("Bulk create records from JSON array (atomic)"));

export const get = Command.make(
  "get",
  {
    db: dbPath,
    id: Argument.string("id").pipe(Argument.withDescription("Record id")),
  },
  Effect.fn(function* ({ db, id }) {
    yield* runDb(db)((database) => database.records.get(id));
  }),
).pipe(Command.withDescription("Get a record by id"));

export const query = Command.make(
  "query",
  {
    db: dbPath,
    labels: labelsFlag,
    where: whereFlag,
    order: orderFlag,
    limit: limitFlag,
    offset: offsetFlag,
  },
  Effect.fn(function* ({ db, labels, where, order, limit, offset }) {
    const queryInput: RecordQuery = {};
    assignIfDefined(queryInput, "labels", splitList(Option.getOrUndefined(labels)));
    assignIfDefined(queryInput, "where", parseWhereFlag(Option.getOrUndefined(where)));
    assignIfDefined(queryInput, "orderBy", parseOrderFlag(Option.getOrUndefined(order)));
    assignIfDefined(queryInput, "limit", Option.getOrUndefined(limit));
    assignIfDefined(queryInput, "offset", Option.getOrUndefined(offset));
    yield* runDb(db)((database) => database.query.find(queryInput));
  }),
).pipe(Command.withDescription("Query records with filters and ordering"));

export const relCreate = Command.make(
  "rel-create",
  {
    db: dbPath,
    type: Flag.string("type").pipe(Flag.withDescription("Relationship type")),
    from: Flag.string("from").pipe(Flag.withDescription("Relationship source record id")),
    to: Flag.string("to").pipe(Flag.withDescription("Relationship target record id")),
    props: propsFlag,
  },
  Effect.fn(function* ({ db, type, from, to, props }) {
    const createInput: Parameters<CheguersDBHandle["relationships"]["create"]>[0] = {
      type,
      sourceId: from,
      targetId: to,
    };
    assignIfDefined(
      createInput,
      "properties",
      parseJsonFlag(Option.getOrUndefined(props), "props"),
    );
    yield* runDb(db)((database) => database.relationships.create(createInput));
  }),
).pipe(Command.withDescription("Create a relationship between two records"));

export const traverse = Command.make(
  "traverse",
  {
    db: dbPath,
    start: startFlag,
    direction: directionFlag,
    types: typesFlag,
    minDepth: minDepthFlag,
    maxDepth: maxDepthFlag,
    limit: limitFlag,
    paths: pathsFlag,
  },
  Effect.fn(function* ({ db, start, direction, types, minDepth, maxDepth, limit, paths }) {
    const spec = buildTraversalSpec({
      start: Option.getOrUndefined(start),
      direction,
      types: Option.getOrUndefined(types),
      minDepth: Option.getOrUndefined(minDepth),
      maxDepth: Option.getOrUndefined(maxDepth),
      limit: Option.getOrUndefined(limit),
      paths,
    });
    yield* runDb(db)((database) => database.traversal.traverse(spec));
  }),
).pipe(Command.withDescription("Traverse the graph from start record ids"));

export const vecUpsert = Command.make(
  "vec-upsert",
  {
    db: dbPath,
    recordId: Argument.string("recordId").pipe(Argument.withDescription("Record id")),
    vector: vectorFlag,
    namespace: namespaceFlag,
  },
  Effect.fn(function* ({ db, recordId, vector, namespace }) {
    const upsertInput: Parameters<CheguersDBHandle["vectors"]["upsert"]>[0] = {
      recordId,
      vector: parseVectorFlag(Option.getOrUndefined(vector), "vector"),
    };
    assignIfDefined(upsertInput, "namespace", Option.getOrUndefined(namespace));
    yield* runDb(db)((database) => database.vectors.upsert(upsertInput));
  }),
).pipe(Command.withDescription("Upsert a vector embedding for a record"));

export const vecSearch = Command.make(
  "vec-search",
  {
    db: dbPath,
    vector: vectorFlag,
    metric: metricFlag,
    topK: topKFlag,
    namespace: namespaceFlag,
    labels: labelsFlag,
    where: whereFlag,
    maxDistance: maxDistanceFlag,
  },
  Effect.fn(function* ({ db, vector, metric, topK, namespace, labels, where, maxDistance }) {
    const searchInput: Parameters<CheguersDBHandle["vectors"]["search"]>[0] = {
      vector: parseVectorFlag(Option.getOrUndefined(vector), "vector"),
      metric,
    };
    assignIfDefined(searchInput, "topK", Option.getOrUndefined(topK));
    assignIfDefined(searchInput, "namespace", Option.getOrUndefined(namespace));
    assignIfDefined(searchInput, "labels", splitList(Option.getOrUndefined(labels)));
    assignIfDefined(searchInput, "where", parseWhereFlag(Option.getOrUndefined(where)));
    assignIfDefined(searchInput, "maxDistance", Option.getOrUndefined(maxDistance));
    yield* runDb(db)((database) => database.vectors.search(searchInput));
  }),
).pipe(Command.withDescription("Search records by vector similarity"));

export const hybrid = Command.make(
  "hybrid",
  {
    db: dbPath,
    vector: vectorFlag,
    metric: metricFlag,
    namespace: namespaceFlag,
    labels: labelsFlag,
    where: whereFlag,
    seeds: seedsFlag,
    expandDepth: expandDepthFlag,
    direction: directionFlag,
    types: typesFlag,
    topN: topNFlag,
    provenance: provenanceFlag,
  },
  Effect.fn(function* ({
    db,
    vector,
    metric,
    namespace,
    labels,
    where,
    seeds,
    expandDepth,
    direction,
    types,
    topN,
    provenance,
  }) {
    const queryInput = buildHybridQuery({
      vector: parseVectorFlag(Option.getOrUndefined(vector), "vector"),
      metric,
      namespace: Option.getOrUndefined(namespace),
      labels: Option.getOrUndefined(labels),
      where: Option.getOrUndefined(where),
      seeds: Option.getOrUndefined(seeds),
      expandDepth: Option.getOrUndefined(expandDepth),
      direction,
      types: Option.getOrUndefined(types),
      topN: Option.getOrUndefined(topN),
      provenance,
    });
    yield* runDb(db)((database) => database.hybrid.search(queryInput));
  }),
).pipe(Command.withDescription("Hybrid vector + graph search"));

export const schema = Command.make(
  "schema",
  {
    db: dbPath,
    label: labelFlag,
  },
  Effect.fn(function* ({ db, label }) {
    const labelValue = Option.getOrUndefined(label);
    yield* runDb(db)((database) =>
      database.schema.introspect(labelValue === undefined ? undefined : { label: labelValue }),
    );
  }),
).pipe(Command.withDescription("Introspect inferred schema"));

export const stats = Command.make(
  "stats",
  {
    db: dbPath,
  },
  Effect.fn(function* ({ db }) {
    yield* runDb(db)((database) =>
      Effect.gen(function* () {
        const records = yield* database.query.find({});
        const schemaResult = yield* database.schema.introspect();
        return {
          path: db,
          records: records.length,
          labels: [...new Set(records.flatMap((record) => record.labels))],
          schemaEntries: schemaResult.length,
        };
      }),
    );
  }),
).pipe(Command.withDescription("Show database statistics"));

export const subcommands = [
  importCmd,
  bulk,
  get,
  query,
  relCreate,
  traverse,
  vecUpsert,
  vecSearch,
  hybrid,
  schema,
  stats,
] as const;
