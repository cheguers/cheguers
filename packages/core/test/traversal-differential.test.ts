import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { open } from "../src/cheguersdb.js"
import type { CheguersDBHandle } from "../src/cheguersdb.js"
import type {
  TraversalResult,
  TraversalSpec
} from "../src/relationships/traversal.js"

let dir: string
let db: CheguersDBHandle | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-travdiff-"))
})

afterEach(async () => {
  if (db !== undefined) {
    await Effect.runPromiseExit(db.close)
    db = undefined
  }
})

/** Deterministic LCG so differential fixtures are reproducible. */
const makeLcg = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

interface RandomGraphSpec {
  readonly nodeCount: number
  readonly edgeCount: number
  readonly types: ReadonlyArray<string>
  /** Probability an edge is a backward edge under the canonical chain order. */
  readonly backEdgeProbability: number
}

const buildRandomGraph = async (
  handle: CheguersDBHandle,
  seed: number,
  spec: RandomGraphSpec
): Promise<Array<string>> => {
  const rng = makeLcg(seed)
  const ids: Array<string> = []
  for (let i = 0; i < spec.nodeCount; i++) {
    const id = `rec_diff_${String(i).padStart(6, "0")}`
    ids.push(id)
    await Effect.runPromise(
      handle.records.create({ id, data: { index: i } })
    )
  }
  for (let e = 0; e < spec.edgeCount; e++) {
    let sourceIdx = Math.floor(rng() * spec.nodeCount)
    let targetIdx = Math.floor(rng() * spec.nodeCount)
    if (rng() >= spec.backEdgeProbability && sourceIdx > targetIdx) {
      const tmp = sourceIdx
      sourceIdx = targetIdx
      targetIdx = tmp
    }
    // Dense small graphs may duplicate; skip exact duplicates via dedupe on
    // type as well by re-rolling the pair.
    if (sourceIdx === targetIdx) continue
    const type = spec.types[Math.floor(rng() * spec.types.length)]!
    await Effect.runPromise(
      handle.relationships.create({
        type,
        sourceId: ids[sourceIdx]!,
        targetId: ids[targetIdx]!
      })
    )
  }
  return ids
}

const specsFor = (ids: Array<string>, depth3: boolean): Array<TraversalSpec> => {
  const depths: Array<[number | undefined, number]> = depth3
    ? [[1, 1], [1, 2], [undefined, 3], [0, 3], [2, 3], [0, 0]]
    : [[1, 1], [0, 2]]
  const specs: Array<TraversalSpec> = []
  for (const direction of ["outgoing", "incoming", "both"] as const) {
    for (const [minDepth, maxDepth] of depths) {
      specs.push({
        startIds: [ids[0]!, ...(ids.length > 3 ? [ids[3]!] : [])],
        direction,
        minDepth,
        maxDepth,
        limit: 10000,
        includePaths: true
      })
      if ((minDepth === undefined || minDepth <= 1) && maxDepth >= 1) {
        specs.push({
          startIds: [ids[Math.min(2, ids.length - 1)]!],
          direction,
          maxDepth,
          relationshipTypes: ["chain"],
          includePaths: true
        })
      }
    }
  }
  return specs
}

const stripMeta = (
  result: TraversalResult
): Pick<TraversalResult, "hits"> & { paths?: unknown } => ({
  hits: result.hits.map((h) => ({ id: h.record.id, depth: h.depth })),
  ...(result.paths !== undefined ? { paths: result.paths } : {})
})

describe("differential: bfs vs recursive CTE traversal", () => {
  it("matches on a deterministic 12-node typed graph across spec permutations", async () => {
    db = await Effect.runPromise(
      open(join(dir, `diff-1-${Math.random().toString(36).slice(2)}.db`))
    )
    const ids = await buildRandomGraph(db, 42, {
      nodeCount: 12,
      edgeCount: 30,
      types: ["chain", "link"],
      backEdgeProbability: 0.15
    })

    for (const spec of specsFor(ids, true)) {
      for (const strategy of ["bfs", "recursive-cte"] as const) {
        void strategy
      }
      const bfs = await Effect.runPromise(
        db.traversal.traverse({ ...spec, strategy: "bfs" })
      )
      const cte = await Effect.runPromise(
        db.traversal.traverse({ ...spec, strategy: "recursive-cte" })
      )
      expect(stripMeta(cte), JSON.stringify(spec)).toEqual(stripMeta(bfs))
    }
  })

  it("matches on a cyclic mixed graph with unreachable islands", async () => {
    db = await Effect.runPromise(
      open(join(dir, `diff-2-${Math.random().toString(36).slice(2)}.db`))
    )
    const ids = await buildRandomGraph(db, 7, {
      nodeCount: 14,
      edgeCount: 40,
      types: ["chain", "jump", "back"],
      backEdgeProbability: 0.45
    })
    // Guarantee at least one cycle and one isolated component.
    await Effect.runPromise(
      db.relationships.create({
        type: "chain",
        sourceId: ids[5]!,
        targetId: ids[7]!
      })
    )
    await Effect.runPromise(
      db.relationships.create({
        type: "back",
        sourceId: ids[7]!,
        targetId: ids[3]!
      })
    )

    for (const spec of specsFor(ids, true)) {
      const bfs = await Effect.runPromise(
        db.traversal.traverse({ ...spec, strategy: "bfs" })
      )
      const cte = await Effect.runPromise(
        db.traversal.traverse({ ...spec, strategy: "recursive-cte" })
      )
      expect(stripMeta(cte), JSON.stringify(spec)).toEqual(stripMeta(bfs))
    }
  }, 60000)

  it("reproduces stored-provenance equality after close/reopen", async () => {
    const path = join(dir, `diff-persist-${Math.random().toString(36).slice(2)}.db`)
    const specBase: Omit<TraversalSpec, "strategy"> = {
      startIds: [],
      direction: "both",
      maxDepth: 3,
      includePaths: true
    }

    db = await Effect.runPromise(open(path))
    const ids = await buildRandomGraph(db, 99, {
      nodeCount: 10,
      edgeCount: 18,
      types: ["chain"],
      backEdgeProbability: 0.25
    })
    const runFirst = await Effect.runPromise(
      db.traversal.traverse({
        ...specBase,
        startIds: [ids[0]!],
        strategy: "bfs"
      })
    )
    const cteBefore = await Effect.runPromise(
      db.traversal.traverse({
        ...specBase,
        startIds: [ids[0]!],
        strategy: "recursive-cte"
      })
    )
    await Effect.runPromiseExit(db.close)
    db = undefined

    db = await Effect.runPromise(open(path))
    const bfsAfter = await Effect.runPromise(
      db.traversal.traverse({
        ...specBase,
        startIds: [ids[0]!],
        strategy: "bfs"
      })
    )

    expect(stripMeta(runFirst)).toEqual(stripMeta(bfsAfter))
    expect(stripMeta(cteBefore)).toEqual(stripMeta(bfsAfter))
  })
})
