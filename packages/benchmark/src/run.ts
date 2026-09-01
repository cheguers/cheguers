import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { open } from "@cheguers/core"
import { type BenchmarkReport, type ScenarioResult } from "./report.js"

const percentiles = (values: ReadonlyArray<number>): Pick<ScenarioResult, "p50" | "p95" | "p99"> => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

const timed = async <A>(run: () => Promise<A>): Promise<number> => {
  const startedAt = performance.now()
  await run()
  return performance.now() - startedAt
}

/** Deterministic LCG so every run sees the same dataset. */
const makeRandom = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const main = Effect.gen(function* () {
  const recordCount = Number(process.argv[2] ?? 200)
  const measuredRuns = Number(process.argv[3] ?? 50)
  const vectorDimensions = Number(process.argv[4] ?? 8)
  const secondaryVectorDimensions = vectorDimensions * 4
  const warmupRuns = 5
  const random = makeRandom(42)

  const dir = mkdtempSync(join(tmpdir(), "cheguers-bench-"))
  const dbPath = join(dir, "bench.db")
  const db = yield* open(dbPath)
  const scenarios: Array<ScenarioResult> = []

  // ---------------------------------------------------------------- ingestion
  for (let i = 0; i < warmupRuns; i++) {
    yield* db.records.create({ data: { n: -i - 1 }, labels: ["warmup"] })
  }

  const createLatenciesMs: Array<number> = []
  const recordIds: string[] = []
  for (let i = 0; i < recordCount; i++) {
    const id = `rec_bench_${String(i).padStart(12, "0")}`
    const latencyMs = yield* Effect.promise(() =>
      timed(() =>
        Effect.runPromise(
          db.records.create({
            id,
            data: { n: i, bucket: i % 10 },
            labels: ["bench_record"]
          })
        )
      )
    )
    recordIds.push(id)
    createLatenciesMs.push(latencyMs)
  }
  scenarios.push({ name: "ingestion.records", unit: "ms", ...percentiles(createLatenciesMs) })
  scenarios.push({
    name: "ingestion.records_throughput",
    unit: "ops/s",
    ...percentiles(createLatenciesMs.map((ms) => (ms > 0 ? 1000 / ms : 0)))
  })

  const bulkLatenciesMs: Array<number> = []
  const batchSize = 25
  for (let batch = 0; batch < Math.max(1, Math.floor(measuredRuns / batchSize)); batch++) {
    const inputs = Array.from({ length: batchSize }, (_, k) => ({
      id: `rec_bulk_${batch}_${k}`.padEnd(14, "_"),
      data: { n: 1000 + batch * batchSize + k },
      labels: ["bulk"]
    }))
    bulkLatenciesMs.push(
      yield* Effect.promise(() => timed(() => Effect.runPromise(db.bulk.createRecords(inputs))))
    )
  }
  scenarios.push({
    name: "ingestion.bulk_25",
    unit: "ms",
    ...percentiles(bulkLatenciesMs)
  })
  scenarios.push({
    name: "ingestion.bulk_25_throughput",
    unit: "ops/s",
    ...percentiles(bulkLatenciesMs.map((ms) => (ms > 0 ? 1000 / (ms / batchSize) : 0)))
  })

  // Chain-shaped graph: rec_i -> rec_(i+1); hubs for fanout measurement.
  const relationshipInputs: Array<{
    readonly type: string
    readonly sourceId: string
    readonly targetId: string
  }> = []
  for (let i = 0; i < recordIds.length - 1; i++) {
    relationshipInputs.push({
      type: "chain_next",
      sourceId: recordIds[i]!,
      targetId: recordIds[i + 1]!
    })
  }
  const hubId = recordIds[0]!
  const lowFanoutId = recordIds[Math.floor(recordIds.length / 2)]!
  for (let i = 1; i <= 24 && i < recordIds.length; i++) {
    relationshipInputs.push({ type: "hub_edge", sourceId: hubId, targetId: recordIds[i]! })
  }

  const relChunkSize = 50
  const relIngestStartedAt = performance.now()
  for (let start = 0; start < relationshipInputs.length; start += relChunkSize) {
    yield* db.bulk.createRelationships(relationshipInputs.slice(start, start + relChunkSize))
  }
  const relIngestMs = performance.now() - relIngestStartedAt
  scenarios.push({
    name: "ingestion.relationships_throughput",
    unit: "ops/s",
    p50: 1000 / (relIngestMs / relationshipInputs.length),
    p95: 1000 / (relIngestMs / relationshipInputs.length),
    p99: 1000 / (relIngestMs / relationshipInputs.length)
  })

  const traverseLatenciesMs: Record<string, Array<number>> = {
    "graph.traverse_1hop": [],
    "graph.traverse_2hop": [],
    "graph.traverse_3hop": []
  }
  for (const [name, maxDepth] of [
    ["graph.traverse_1hop", 1],
    ["graph.traverse_2hop", 2],
    ["graph.traverse_3hop", 3]
  ] as const) {
    for (let r = 0; r < warmupRuns; r++) {
      yield* db.traversal.traverse({
        startIds: [hubId],
        direction: "outgoing",
        maxDepth
      })
    }
    for (let r = 0; r < measuredRuns; r++) {
      traverseLatenciesMs[name]!.push(
        yield* Effect.promise(() =>
          timed(() =>
            Effect.runPromise(
              db.traversal.traverse({
                startIds: [hubId],
                direction: "outgoing",
                maxDepth
              })
            )
          )
        )
      )
    }
    scenarios.push({ name, unit: "ms", ...percentiles(traverseLatenciesMs[name]!) })
  }

  // Fanout sensitivity: high-fanout hub vs low-fanout chain midpoint.
  for (const [name, startId] of [
    ["graph.traverse_2hop_fanout_high", hubId],
    ["graph.traverse_2hop_fanout_low", lowFanoutId]
  ] as const) {
    for (let r = 0; r < warmupRuns; r++) {
      yield* db.traversal.traverse({ startIds: [startId], direction: "outgoing", maxDepth: 2 })
    }
    const latenciesMs: Array<number> = []
    for (let r = 0; r < measuredRuns; r++) {
      latenciesMs.push(
        yield* Effect.promise(() =>
          timed(() =>
            Effect.runPromise(
              db.traversal.traverse({ startIds: [startId], direction: "outgoing", maxDepth: 2 })
            )
          )
        )
      )
    }
    scenarios.push({ name, unit: "ms", ...percentiles(latenciesMs) })
  }

  // BFS vs recursive-CTE differential performance (same public contract).
  for (const [name, strategy] of [
    ["graph.traverse_2hop_bfs", "bfs"],
    ["graph.traverse_2hop_recursive_cte", "recursive-cte"],
    ["graph.traverse_3hop_bfs", "bfs"],
    ["graph.traverse_3hop_recursive_cte", "recursive-cte"]
  ] as const) {
    const maxDepth = name.includes("3hop") ? 3 : 2
    for (let r = 0; r < warmupRuns; r++) {
      yield* db.traversal.traverse({
        startIds: [hubId],
        direction: "outgoing",
        maxDepth,
        strategy
      })
    }
    const latenciesMs: Array<number> = []
    for (let r = 0; r < measuredRuns; r++) {
      latenciesMs.push(
        yield* Effect.promise(() =>
          timed(() =>
            Effect.runPromise(
              db.traversal.traverse({
                startIds: [hubId],
                direction: "outgoing",
                maxDepth,
                strategy
              })
            )
          )
        )
      )
    }
    scenarios.push({ name, unit: "ms", ...percentiles(latenciesMs) })
  }

  // ------------------------------------------------------------------- vectors
  yield* db.bulk.upsertVectors(
    recordIds.map((id, i) => ({
      recordId: id,
      namespace: "default",
      vector: Array.from({ length: vectorDimensions }, (_, d) =>
        random() > 0.5 ? (i + d) / recordCount : -(i + d) / recordCount
      )
    }))
  )
  // A second namespace with higher dimensionality for the dimension sweep.
  yield* db.bulk.upsertVectors(
    recordIds.map((id, i) => ({
      recordId: id,
      namespace: "wide",
      vector: Array.from({ length: secondaryVectorDimensions }, (_, d) =>
        random() > 0.5 ? (i + d) / recordCount : -(i + d) / recordCount
      )
    }))
  )

  const queryVector = Array.from({ length: vectorDimensions }, (_, d) => d / vectorDimensions)
  const wideQueryVector = Array.from(
    { length: secondaryVectorDimensions },
    (_, d) => d / secondaryVectorDimensions
  )

  for (const [name, metric, filtered] of [
    ["vector.cosine_search", "cosine", false],
    ["vector.l2_search", "l2", false],
    ["vector.cosine_search_filtered", "cosine", true]
  ] as const) {
    for (let r = 0; r < warmupRuns; r++) {
      yield* db.vectors.search({
        vector: queryVector,
        metric,
        topK: 10,
        ...(filtered ? { labels: ["bench_record"] as const } : {})
      })
    }
    const latenciesMs: Array<number> = []
    for (let r = 0; r < measuredRuns; r++) {
      latenciesMs.push(
        yield* Effect.promise(() =>
          timed(() =>
            Effect.runPromise(
              db.vectors.search({
                vector: queryVector,
                metric,
                topK: 10,
                ...(filtered ? { labels: ["bench_record"] as const } : {})
              })
            )
          )
        )
      )
    }
    scenarios.push({ name, unit: "ms", ...percentiles(latenciesMs) })
  }

  // Dimension effect: same record count, 4x dimensionality.
  for (let r = 0; r < warmupRuns; r++) {
    yield* db.vectors.search({
      namespace: "wide",
      vector: wideQueryVector,
      metric: "cosine",
      topK: 10
    })
  }
  const wideLatenciesMs: Array<number> = []
  for (let r = 0; r < measuredRuns; r++) {
    wideLatenciesMs.push(
      yield* Effect.promise(() =>
        timed(() =>
          Effect.runPromise(
            db.vectors.search({
              namespace: "wide",
              vector: wideQueryVector,
              metric: "cosine",
              topK: 10
            })
          )
        )
      )
    )
  }
  scenarios.push({
    name: `vector.cosine_search_dims_${secondaryVectorDimensions}`,
    unit: "ms",
    ...percentiles(wideLatenciesMs)
  })

  // Candidate-set size effect: topK 10 vs topK 100.
  for (const [name, topK] of [
    ["vector.cosine_search_topk_10", 10],
    ["vector.cosine_search_topk_100", 100]
  ] as const) {
    const latenciesMs: Array<number> = []
    for (let r = 0; r < measuredRuns + warmupRuns; r++) {
      const ms = yield* Effect.promise(() =>
        timed(() =>
          Effect.runPromise(
            db.vectors.search({ vector: queryVector, metric: "cosine", topK })
          )
        )
      )
      if (r >= warmupRuns) latenciesMs.push(ms)
    }
    scenarios.push({ name, unit: "ms", ...percentiles(latenciesMs) })
  }

  // -------------------------------------------------------------------- hybrid
  const hybridBase = {
    vector: queryVector,
    metric: "cosine",
    seeds: 10,
    topN: 10
  } as const
  for (const [name, extra] of [
    ["hybrid.filter_first_mode_a", { expandDepth: 0, labels: ["bench_record"] }] as const,
    ["hybrid.vector_graph_rerank", { expandDepth: 2 }] as const,
    ["hybrid.rerank_overhead_3hop", { expandDepth: 3 }] as const
  ] as const) {
    for (let r = 0; r < warmupRuns; r++) {
      yield* db.hybrid.search({ ...hybridBase, ...extra })
    }
    const latenciesMs: Array<number> = []
    for (let r = 0; r < measuredRuns; r++) {
      latenciesMs.push(
        yield* Effect.promise(() =>
          timed(() => Effect.runPromise(db.hybrid.search({ ...hybridBase, ...extra })))
        )
      )
    }
    scenarios.push({ name, unit: "ms", ...percentiles(latenciesMs) })
  }

  yield* db.close

  const dbSizeBytes = statSync(dbPath).size
  const report: BenchmarkReport = {
    environment: {
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      datasetSeed: 42,
      recordCount,
      measuredFanout: relationshipInputs.length / recordIds.length,
      vectorDimensions,
      secondaryVectorDimensions,
      warmupRuns,
      measuredRuns,
      dbSizeBytes,
      rssBytes: process.memoryUsage().rss
    },
    scenarios
  }
  console.log(JSON.stringify(report, null, 2))

  rmSync(dir, { recursive: true, force: true })
})

main.pipe(Effect.runPromise).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
