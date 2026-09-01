import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { open } from "../src/cheguersdb.js"
import type { CheguersDBHandle } from "../src/cheguersdb.js"
import { NotFoundError, ValidationError } from "../src/errors.js"

let dir: string
let db: CheguersDBHandle | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-vec-"))
})

const setup = async (): Promise<CheguersDBHandle> => {
  const dbPath = join(dir, `test-${Math.random().toString(36).slice(2)}.db`)
  db = await Effect.runPromise(open(dbPath))
  return db
}

afterEach(async () => {
  if (db !== undefined) {
    await Effect.runPromiseExit(db.close)
    db = undefined
  }
})

const seedRecord = async (
  database: CheguersDBHandle,
  id: string,
  labels: string[] = [],
  data: Record<string, unknown> = {}
): Promise<void> => {
  await Effect.runPromise(
    database.records.create({
      id,
      data: data as never,
      labels: [...labels]
    })
  )
}

describe("vector persistence", () => {
  it("round-trips vectors through upsert and get", async () => {
    const db = await setup()
    await seedRecord(db, "rec_vec_a_000001")
    const meta = await Effect.runPromise(
      db.vectors.upsert({
        recordId: "rec_vec_a_000001",
        vector: [1, 0, 0]
      })
    )
    expect(meta.recordId).toBe("rec_vec_a_000001")
    expect(meta.namespace).toBe("default")
    expect(meta.dimensions).toBe(3)

    const fetched = await Effect.runPromise(
      db.vectors.get("rec_vec_a_000001")
    )
    expect(fetched.dimensions).toBe(3)
  })

  it("rejects unknown records", async () => {
    const db = await setup()
    const error = await Effect.runPromise(
      Effect.flip(
        db.vectors.upsert({ recordId: "rec_missing_0001", vector: [1] })
      )
    )
    expect(error).toBeInstanceOf(NotFoundError)
  })

  it("enforces dimension consistency within a namespace", async () => {
    const db = await setup()
    await seedRecord(db, "rec_vec_b_000001")
    await seedRecord(db, "rec_vec_b_000002")
    await Effect.runPromise(
      db.vectors.upsert({ recordId: "rec_vec_b_000001", vector: [1, 2, 3] })
    )
    const error = await Effect.runPromise(
      Effect.flip(
        db.vectors.upsert({ recordId: "rec_vec_b_000002", vector: [1, 2] })
      )
    )
    expect(error).toBeInstanceOf(ValidationError)

    // Same dimensionality across records is fine.
    await Effect.runPromise(
      db.vectors.upsert({ recordId: "rec_vec_b_000002", vector: [4, 5, 6] })
    )

    // A different namespace may use a different dimensionality.
    await Effect.runPromise(
      db.vectors.upsert({
        recordId: "rec_vec_b_000002",
        namespace: "title",
        vector: [9, 9]
      })
    )
  })

  it("rejects invalid vector values and namespaces", async () => {
    const db = await setup()
    await seedRecord(db, "rec_vec_c_000001")

    const empty = await Effect.runPromise(
      Effect.flip(db.vectors.upsert({ recordId: "rec_vec_c_000001", vector: [] }))
    )
    expect(empty).toBeInstanceOf(ValidationError)

    const nan = await Effect.runPromise(
      Effect.flip(
        db.vectors.upsert({
          recordId: "rec_vec_c_000001",
          vector: [Number.NaN]
        })
      )
    )
    expect(nan).toBeInstanceOf(ValidationError)

    const nsErr = await Effect.runPromise(
      Effect.flip(
        db.vectors.upsert({
          recordId: "rec_vec_c_000001",
          namespace: "bad ns!",
          vector: [1]
        })
      )
    )
    expect(nsErr).toBeInstanceOf(ValidationError)
  })

  it("deletes vectors and reports NotFound afterwards", async () => {
    const db = await setup()
    await seedRecord(db, "rec_vec_d_000001")
    await Effect.runPromise(
      db.vectors.upsert({ recordId: "rec_vec_d_000001", vector: [1, 1] })
    )
    await Effect.runPromise(db.vectors.remove("rec_vec_d_000001"))
    const error = await Effect.runPromise(
      Effect.flip(db.vectors.get("rec_vec_d_000001"))
    )
    expect(error).toBeInstanceOf(NotFoundError)

    const missingDelete = await Effect.runPromise(
      Effect.flip(db.vectors.remove("rec_vec_d_000001"))
    )
    expect(missingDelete).toBeInstanceOf(NotFoundError)
  })

  it("persists vectors across close and reopen", async () => {
    const dbPath = join(dir, "persist.db")
    const first = await Effect.runPromise(open(dbPath))
    await Effect.runPromise(
      first.records.create({ id: "rec_persist_v01", data: {} })
    )
    await Effect.runPromise(
      first.vectors.upsert({
        recordId: "rec_persist_v01",
        vector: [0.5, -0.25, 2]
      })
    )
    await Effect.runPromise(first.close)

    const second = await Effect.runPromise(open(dbPath))
    const fetched = await Effect.runPromise(second.vectors.get("rec_persist_v01"))
    expect(fetched.dimensions).toBe(3)
    await Effect.runPromise(second.close)
  })
})

describe("exact vector search", () => {
  beforeEach(async () => {
    // Geometry (cosine): east is closest to the query direction,
    // then diagonal, then north, then west (opposite).
    const d = await setup()
    await seedRecord(d, "rec_search_east", [], {})
    await seedRecord(d, "rec_search_diag", [])
    await seedRecord(d, "rec_search_north", [])
    await seedRecord(d, "rec_search_west", [])

    await Effect.all([
      d.vectors.upsert({ recordId: "rec_search_east", vector: [1, 0] }),
      d.vectors.upsert({ recordId: "rec_search_diag", vector: [1, 1] }),
      d.vectors.upsert({ recordId: "rec_search_north", vector: [0, 1] }),
      d.vectors.upsert({ recordId: "rec_search_west", vector: [-1, 0] })
    ]).pipe(Effect.runPromise)
  })

  it("ranks cosine results deterministically", async () => {
    const d = db!
    const hits = await Effect.runPromise(
      d.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        topK: 4
      })
    )
    expect(hits.map((h) => h.record.id)).toEqual([
      "rec_search_east",
      "rec_search_diag",
      "rec_search_north",
      "rec_search_west"
    ])
    // Cosine distance increases monotonically along that order.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance)
    }
  })

  it("ranks L2 results by euclidean distance", async () => {
    const d = db!
    const hits = await Effect.runPromise(
      d.vectors.search({
        vector: [0.6, 0],
        metric: "l2",
        topK: 4
      })
    )
    // east dist .4; diag sqrt(.36+1)=~1.166; west 1.6; north ~1.166 too.
    expect(hits[0]!.record.id).toBe("rec_search_east")
    expect(hits[hits.length - 1]!.record.id).toBe("rec_search_west")
  })

  it("honors topK and maxDistance thresholds", async () => {
    const d = db!
    const two = await Effect.runPromise(
      d.vectors.search({ vector: [1, 0], metric: "cosine", topK: 2 })
    )
    expect(two.map((h) => h.record.id)).toEqual([
      "rec_search_east",
      "rec_search_diag"
    ])

    const thresholded = await Effect.runPromise(
      d.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        maxDistance: 0.29
      })
    )
    expect(thresholded.map((h) => h.record.id)).toEqual(["rec_search_east"])
  })

  it("isolates namespaces", async () => {
    const db = await setup()
    const hits = await Effect.runPromise(
      db.vectors.search({ namespace: "nonexistent_ns", vector: [1, 0], metric: "cosine" })
    )
    expect(hits).toEqual([])
  })
})

describe("filtered vector search", () => {
  it("applies label filters before distance ranking", async () => {
    const db = await setup()
    await seedRecord(db, "rec_fil_ok_prod", ["product"])
    await seedRecord(db, "rec_fil_close_prod", ["product"])
    await seedRecord(db, "rec_fil_close_user", ["user"])

    await Effect.all([
      db.vectors.upsert({ recordId: "rec_fil_ok_prod", vector: [1, 0] }),
      db.vectors.upsert({ recordId: "rec_fil_close_prod", vector: [0.8, 0.2] }),
      db.vectors.upsert({ recordId: "rec_fil_close_user", vector: [1, 0] })
    ]).pipe(Effect.runPromise)

    const hits = await Effect.runPromise(
      db.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        labels: ["product"]
      })
    )
    expect(hits.map((h) => h.record.id)).toEqual([
      "rec_fil_ok_prod",
      "rec_fil_close_prod"
    ])
  })

  it("applies property filters through the query DSL", async () => {
    const db = await setup()
    await seedRecord(db, "rec_fil_prop_a", [], { tier: "gold" })
    await seedRecord(db, "rec_fil_prop_b", [], { tier: "silver" })

    await Effect.all([
      db.vectors.upsert({ recordId: "rec_fil_prop_a", vector: [1, 1] }),
      db.vectors.upsert({ recordId: "rec_fil_prop_b", vector: [1, 0] })
    ]).pipe(Effect.runPromise)

    const hits = await Effect.runPromise(
      db.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        where: { property: "tier", op: "eq", value: "gold" }
      })
    )
    expect(hits.map((h) => h.record.id)).toEqual(["rec_fil_prop_a"])
  })

  it("applies relationship filters via related specs", async () => {
    const db = await setup()
    await seedRecord(db, "rec_fil_rel_owner", [])
    await seedRecord(db, "rec_fil_rel_doc_far", [])
    await seedRecord(db, "rec_fil_rel_doc_near", [])

    await Effect.runPromise(
      db.relationships.create({
        type: "authored",
        sourceId: "rec_fil_rel_owner",
        targetId: "rec_fil_rel_doc_near"
      })
    )

    await Effect.all([
      db.vectors.upsert({ recordId: "rec_fil_rel_doc_near", vector: [0.9, 0.1] }),
      db.vectors.upsert({ recordId: "rec_fil_rel_doc_far", vector: [1, 0] })
    ]).pipe(Effect.runPromise)

    const hits = await Effect.runPromise(
      db.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        where: {
          related: {
            type: "authored",
            direction: "incoming",
            minHops: 1,
            maxHops: 1
          }
        }
      })
    )
    expect(hits.map((h) => h.record.id)).toEqual(["rec_fil_rel_doc_near"])
  })

  it("returns an empty result set when filters match nothing", async () => {
    const db = await setup()
    await seedRecord(db, "rec_fil_none", ["unrelated"])
    await Effect.runPromise(
      db.vectors.upsert({ recordId: "rec_fil_none", vector: [1, 0] })
    )
    const hits = await Effect.runPromise(
      db.vectors.search({
        vector: [1, 0],
        metric: "cosine",
        labels: ["no_such_label"]
      })
    )
    expect(hits).toEqual([])
  })
})
