import { parseArgs } from "node:util"
import { readFileSync } from "node:fs"
import { Effect, Exit } from "effect"
import {
  open,
  type CheguersDBHandle,
  type CheguersError,
  type CreateRecordInput,
  type JsonObject,
  type OrderBy,
  type RecordQuery,
  type TraversalSpec,
  type VectorMetric,
  type WhereExpression
} from "@cheguers/core"

const fail: (message: string) => never = (message) => {
  console.error(JSON.stringify({ error: message }, null, 2))
  process.exit(2)
}

const usage: () => never = () => {
  console.error(`cheguers — thin CLI over CheguersDB core

Usage: cheguers <command> <db> [options]

Commands:
  import      <db> <file> [--labels a,b]        nested JSON -> graph (atomic)
  bulk        <db> <file>                        file = [{data, labels}] (atomic)
  get         <db> <id>
  query       <db> [--labels a,b] [--where json] [--order p:asc,p2:desc]
                                                 [--limit n] [--offset n]
  rel-create  <db> --type T --from id --to id [--props json]
  traverse    <db> --start id1,id2 [--direction outgoing|incoming|both]
              [--types A,B] [--min-depth n] [--max-depth n] [--limit n] [--paths]
  vec-upsert  <db> <recordId> --vector 1,2,3 [--namespace ns]
  vec-search  <db> --vector 1,0,0 [--metric cosine|l2] [--topK n] [--namespace ns]
              [--labels a,b] [--where json] [--max-distance d]
  hybrid      <db> --vector 1,0,0 [--metric cosine|l2] [--namespace ns]
              [--labels a,b] [--where json] [--seeds n] [--expand-depth 0-3]
              [--direction outgoing|incoming|both] [--types A,B] [--top-n n]
              [--provenance]
  schema      <db> [--label L]
  stats       <db>`)
  process.exit(2)
}

const runExit = async <A>(effect: Effect.Effect<A, CheguersError>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const cause = exit.cause as unknown as {
    reasons?: ReadonlyArray<{ error?: unknown }>
    error?: unknown
  }
  const error = cause?.reasons?.[0]?.error ?? cause?.reasons?.[0] ?? cause?.error ?? cause
  console.error(JSON.stringify({ error }, null, 2))
  process.exit(1)
}

const withDb = async <A>(
  path: string,
  fn: (db: CheguersDBHandle) => Promise<A>
): Promise<A> => {
  const db = await Effect.runPromise(open(path))
  try {
    return await fn(db)
  } finally {
    await Effect.runPromiseExit(db.close)
  }
}

function splitList(value: string): string[]
function splitList(value: string | undefined): string[] | undefined
function splitList(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value.split(",").map((s) => s.trim()).filter(Boolean)
}

const numList = (value: string | undefined, flag: string): number[] => {
  if (value === undefined) fail(`missing --${flag}`)
  const parts = value.split(",").map((s) => Number(s.trim()))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) {
    fail(`--${flag} must be a comma-separated list of finite numbers`)
  }
  return parts
}

const readJson = (file: string | undefined): unknown => {
  if (file === undefined) fail("missing <file> argument")
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (cause) {
    fail(`cannot read JSON file ${String(file)}: ${String(cause)}`)
  }
}

const parseJson = (value: string | undefined, flag: string): unknown => {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    fail(`--${flag} is not valid JSON`)
  }
}

const orderBys = (value: string | undefined): ReadonlyArray<OrderBy> | undefined =>
  value === undefined
    ? undefined
    : value.split(",").map((entry) => {
        const [property, direction] = entry.split(":")
        return {
          property: (property ?? "").trim(),
          direction: direction?.trim() === "desc" ? "desc" : "asc"
        }
      })

const direction = (value: string | undefined): TraversalSpec["direction"] => {
  if (value === undefined) return "outgoing"
  if (value === "outgoing" || value === "incoming" || value === "both") return value
  fail("--direction must be outgoing|incoming|both")
}

const metric = (value: string | undefined): VectorMetric => {
  if (value === undefined) return "cosine"
  if (value === "cosine" || value === "l2") return value
  fail("--metric must be cosine|l2")
}

const intOption = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n)) fail(`--${flag} must be an integer`)
  return n
}

const whereOf = (value: string | undefined): WhereExpression | undefined =>
  value === undefined ? undefined : (parseJson(value, "where") as WhereExpression)

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const [command, dbPath, ...rest] = argv
  if (command === undefined || dbPath === undefined || dbPath.startsWith("-")) usage()

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      labels: { type: "string" },
      label: { type: "string" },
      where: { type: "string" },
      order: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      type: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      props: { type: "string" },
      start: { type: "string" },
      direction: { type: "string" },
      types: { type: "string" },
      "min-depth": { type: "string" },
      "max-depth": { type: "string" },
      paths: { type: "boolean" },
      vector: { type: "string" },
      metric: { type: "string" },
      "top-k": { type: "string" },
      namespace: { type: "string" },
      "max-distance": { type: "string" },
      seeds: { type: "string" },
      "expand-depth": { type: "string" },
      "top-n": { type: "string" },
      provenance: { type: "boolean" }
    },
    allowPositionals: true
  })

  switch (command) {
    case "import": {
      const input = readJson(positionals[0])
      const labels = splitList(values.labels)
      const result = await withDb(dbPath, (db) =>
        runExit(db.imports.run(input as JsonObject, labels ? { rootLabels: labels } : undefined))
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "bulk": {
      const input = readJson(positionals[0])
      if (!Array.isArray(input)) fail("bulk file must be a JSON array of {data, labels}")
      const result = await withDb(dbPath, (db) =>
        runExit(db.bulk.createRecords(input as ReadonlyArray<CreateRecordInput>))
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "get": {
      const id = positionals[0]
      if (id === undefined) fail("missing <id>")
      const record = await withDb(dbPath, (db) => runExit(db.records.get(id)))
      console.log(JSON.stringify(record, null, 2))
      return
    }
    case "query": {
      const limit = intOption(values.limit, "limit")
      const offset = intOption(values.offset, "offset")
      const where = whereOf(values.where)
      const orderBy = orderBys(values.order)
      const labels = values.labels ? splitList(values.labels) : undefined
      const query: RecordQuery = {
        ...(labels !== undefined ? { labels } : {}),
        ...(where !== undefined ? { where } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {})
      }
      const result = await withDb(dbPath, (db) => runExit(db.query.find(query)))
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "rel-create": {
      const type = values.type
      const from = values.from
      const to = values.to
      if (!type || !from || !to) {
        fail("rel-create requires --type, --from, --to")
      }
      const result = await withDb(dbPath, (db) =>
        runExit(
          db.relationships.create({
            type,
            sourceId: from,
            targetId: to,
            ...(values.props ? { properties: parseJson(values.props, "props") as JsonObject } : {})
          })
        )
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "traverse": {
      const startIds = splitList(values.start)
      if (!startIds || startIds.length === 0) fail("traverse requires --start id1,id2")
      const minDepth = intOption(values["min-depth"], "min-depth")
      const maxDepth = intOption(values["max-depth"], "max-depth")
      const limit = intOption(values.limit, "limit")
      const result = await withDb(dbPath, (db) =>
        runExit(
          db.traversal.traverse({
            startIds,
            direction: direction(values.direction),
            ...(values.types ? { relationshipTypes: splitList(values.types) } : {}),
            ...(minDepth !== undefined ? { minDepth } : {}),
            ...(maxDepth !== undefined ? { maxDepth } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(values.paths ? { includePaths: true } : {})
          })
        )
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "vec-upsert": {
      const recordId = positionals[0]
      if (!recordId) fail("vec-upsert requires <recordId>")
      const vector = numList(values.vector, "vector")
      const result = await withDb(dbPath, (db) =>
        runExit(
          db.vectors.upsert({
            recordId,
            vector,
            ...(values.namespace ? { namespace: values.namespace } : {})
          })
        )
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "vec-search": {
      const vector = numList(values.vector, "vector")
      const topK = intOption(values["top-k"], "top-k")
      const maxDistance = values["max-distance"] === undefined ? undefined : Number(values["max-distance"])
      const labels = splitList(values.labels)
      const where = whereOf(values.where)
      const result = await withDb(dbPath, (db) =>
        runExit(
          db.vectors.search({
            vector,
            metric: metric(values.metric),
            ...(topK !== undefined ? { topK } : {}),
            ...(values.namespace ? { namespace: values.namespace } : {}),
            ...(labels ? { labels } : {}),
            ...(where ? { where } : {}),
            ...(maxDistance !== undefined ? { maxDistance } : {})
          })
        )
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "hybrid": {
      const vector = numList(values.vector, "vector")
      const seeds = intOption(values.seeds, "seeds")
      const expandDepth = intOption(values["expand-depth"], "expand-depth")
      const topN = intOption(values["top-n"], "top-n")
      const labels = splitList(values.labels)
      const where = whereOf(values.where)
      const types = splitList(values.types)
      const result = await withDb(dbPath, (db) =>
        runExit(
          db.hybrid.search({
            vector,
            metric: metric(values.metric),
            ...(values.namespace ? { namespace: values.namespace } : {}),
            ...(labels ? { labels } : {}),
            ...(where ? { where } : {}),
            ...(seeds !== undefined ? { seeds } : {}),
            ...(expandDepth !== undefined ? { expandDepth } : {}),
            ...(values.direction ? { direction: direction(values.direction) } : {}),
            ...(types ? { relationshipTypes: types } : {}),
            ...(topN !== undefined ? { topN } : {}),
            ...(values.provenance ? { includeProvenance: true } : {})
          })
        )
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "schema": {
      const result = await withDb(dbPath, (db) =>
        runExit(db.schema.introspect(values.label ? { label: values.label } : undefined))
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "stats": {
      const result = await withDb(dbPath, async (db) => {
        const records = await runExit(db.query.find({}))
        const schema = await runExit(db.schema.introspect())
        const labels = [...new Set(records.flatMap((r) => r.labels))]
        return {
          path: dbPath,
          records: records.length,
          labels,
          schemaEntries: schema.length
        }
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    default:
      usage()
  }
}

await main()
