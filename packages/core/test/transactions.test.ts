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
  dir = mkdtempSync(join(tmpdir(), "cheguers-tx-"))
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

describe("explicit transactions", () => {
  it("commits multi-entity writes as one unit", async () => {
    const db = await setup()
    const created = await Effect.runPromise(
      db.transaction((ops) =>
        Effect.gen(function* () {
          const source = yield* ops.records.create({
            id: "rec_tx_src_000001",
            data: {},
            labels: ["person"]
          })
          const target = yield* ops.records.create({
            id: "rec_tx_tgt_000001",
            data: {}
          })
          const rel = yield* ops.relationships.create({
            type: "knows",
            sourceId: source.id,
            targetId: target.id
          })
          yield* ops.vectors.upsert({
            recordId: source.id,
            vector: [1, 2]
          })
          return { source, rel }
        })
      )
    )
    expect(created.source.id).toBe("rec_tx_src_000001")

    const fetchedRel = await Effect.runPromise(db.relationships.get(created.rel.id))
    expect(fetchedRel.type).toBe("knows")
    const meta = await Effect.runPromise(db.vectors.get("rec_tx_src_000001"))
    expect(meta.dimensions).toBe(2)
  })

  it("rolls back every mutation type on failure with no partial state", async () => {
    const db = await setup()
    await Effect.runPromise(
      db.records.create({ id: "rec_tx_pre_000001", data: {} })
    )

    // Failure inside a transaction touching record + label + relationship +
    // vector + deletion must leave nothing behind.
    const error = await Effect.runPromise(
      Effect.flip(
        db.transaction((ops) =>
          Effect.gen(function* () {
            yield* ops.vectors.upsert({
              recordId: "rec_tx_pre_000001",
              vector: [1, 1]
            })
            const temp = yield* ops.records.create({
              id: "rec_tx_temp_00001",
              data: {},
              labels: ["temp"]
            })
            yield* ops.relationships.create({
              type: "knows",
              sourceId: "rec_tx_pre_000001",
              targetId: temp.id
            })
            yield* ops.records.delete("rec_tx_pre_000001")
            return yield* Effect.fail(new ValidationError({ message: "boom" }))
          })
        )
      )
    )
    expect(error._tag).toBe("ValidationError")

    // Pre-existing record still exists (deletion rolled back).
    const survivor = await Effect.runPromise(db.records.get("rec_tx_pre_000001"))
    expect(survivor.id).toBe("rec_tx_pre_000001")

    // Temp record is gone.
    const missing = await Effect.runPromise(
      Effect.flip(db.records.get("rec_tx_temp_00001"))
    )
    expect(missing).toBeInstanceOf(NotFoundError)

    // Vector upsert was also part of the aborted transaction.
    const noVector = await Effect.runPromise(
      Effect.flip(db.vectors.get("rec_tx_pre_000001"))
    )
    expect(noVector).toBeInstanceOf(NotFoundError)

    const labels = await Effect.runPromise(db.records.listByLabels(["temp"]))
    expect(labels).toEqual([])
  })

  it("supports scoped updates and deletes inside the same transaction", async () => {
    const db = await setup()
    await Effect.runPromise(
      db.records.create({ id: "rec_tx_upd_000001", data: { a: 1 }, labels: ["alpha"] })
    )
    await Effect.runPromise(
      db.records.create({ id: "rec_tx_del_000001", data: {} })
    )
    await Effect.runPromise(
      db.relationships.create({
        type: "tags",
        sourceId: "rec_tx_upd_000001",
        targetId: "rec_tx_del_000001"
      })
    )

    await Effect.runPromise(
      db.transaction((ops) =>
        Effect.gen(function* () {
          yield* ops.records.update("rec_tx_upd_000001", {
            data: { b: 2 },
            addLabels: ["beta"],
            removeLabels: ["alpha"]
          })
          yield* ops.records.delete("rec_tx_del_000001")
        })
      )
    )

    const updated = await Effect.runPromise(db.records.get("rec_tx_upd_000001"))
    expect(updated.data).toEqual({ a: 1, b: 2 })
    expect(updated.labels).toEqual(["beta"])
    const gone = await Effect.runPromise(
      Effect.flip(db.records.get("rec_tx_del_000001"))
    )
    expect(gone).toBeInstanceOf(NotFoundError)
  })
})

describe("bulk operations", () => {
  it("creates many records atomically and matches individual semantics", async () => {
    const db = await setup()
    const created = await Effect.runPromise(
      db.bulk.createRecords([
        { id: "rec_bulk_a_000001", data: { n: 1 }, labels: ["batch"] },
        { id: "rec_bulk_b_000001", data: { n: 2 }, labels: ["batch"] },
        { data: {} }
      ])
    )
    expect(created.length).toBe(3)
    for (const record of created) {
      const fetched = await Effect.runPromise(db.records.get(record.id))
      expect(fetched.data).toEqual(record.data)
    }

    // Individual-operation validation semantics still apply per item.
    const error = await Effect.runPromise(
      Effect.flip(
        db.bulk.createRecords([{ data: {}, labels: ["bad label!"] }])
      )
    )
    expect(error).toBeInstanceOf(ValidationError)
  })

  it("rolls back partial bulk creates on failure", async () => {
    const db = await setup()
    const error = await Effect.runPromise(
      Effect.flip(
        db.bulk.createRecords([
          { id: "rec_bulk_ok_000001", data: {} },
          { id: "not an id!", data: {} }
        ])
      )
    )
    expect(error).toBeInstanceOf(ValidationError)
    const orphan = await Effect.runPromise(
      Effect.flip(db.records.get("rec_bulk_ok_000001"))
    )
    expect(orphan).toBeInstanceOf(NotFoundError)
  })

  it("bulk-creates relationships in one atomic batch", async () => {
    const db = await setup()
    await Effect.runPromise(
      db.bulk.createRecords([
        { id: "rec_bulk_s_000001", data: {} },
        { id: "rec_bulk_t_000001", data: {} },
        { id: "rec_bulk_u_000001", data: {} }
      ])
    )
    const rels = await Effect.runPromise(
      db.bulk.createRelationships([
        { type: "pairs", sourceId: "rec_bulk_s_000001", targetId: "rec_bulk_t_000001" },
        { type: "pairs", sourceId: "rec_bulk_s_000001", targetId: "rec_bulk_u_000001" }
      ])
    )
    expect(rels.length).toBe(2)
    const outgoing = await Effect.runPromise(
      db.relationships.outgoing("rec_bulk_s_000001")
    )
    expect(outgoing.length).toBe(2)
  })

  it("bulk-upserts vectors under one namespace constraint check", async () => {
    const db = await setup()
    await Effect.runPromise(
      db.bulk.createRecords([
        { id: "rec_bulk_v_000001", data: {} },
        { id: "rec_bulk_v_000002", data: {} }
      ])
    )
    await Effect.runPromise(
      db.bulk.upsertVectors([
        { recordId: "rec_bulk_v_000001", vector: [1, 0] },
        { recordId: "rec_bulk_v_000002", vector: [0, 1] }
      ])
    )
    const hits = await Effect.runPromise(
      db.vectors.search({ vector: [1, 0], metric: "cosine" })
    )
    expect(hits.length).toBe(2)
  })

  it("bulk-deletes records including dependents", async () => {
    const db = await setup()
    await Effect.runPromise(
      db.bulk.createRecords([
        { id: "rec_bulk_d_000001", data: {} },
        { id: "rec_bulk_d_000002", data: {} }
      ])
    )
    await Effect.runPromise(
      db.relationships.create({
        type: "adjacent_to",
        sourceId: "rec_bulk_d_000001",
        targetId: "rec_bulk_d_000002"
      })
    )
    const result = await Effect.runPromise(
      db.bulk.deleteRecords(["rec_bulk_d_000001", "rec_bulk_d_000002"])
    )
    expect(result.deleted).toBe(2)
    for (const id of ["rec_bulk_d_000001", "rec_bulk_d_000002"]) {
      const err = await Effect.runPromise(Effect.flip(db.records.get(id)))
      expect(err).toBeInstanceOf(NotFoundError)
    }
    const outgoing = await Effect.runPromise(
      db.relationships.outgoing("rec_bulk_d_000001")
    ).catch(() => [])
    expect(outgoing.length).toBe(0)
  })
})
