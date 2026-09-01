import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/cheguersdb.js";
import type { CheguersDBHandle } from "../src/cheguersdb.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/errors.js";

let dir: string;
let db: CheguersDBHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-"));
});

const setup = async (): Promise<CheguersDBHandle> => {
  const dbPath = join(dir, `test-${Math.random().toString(36).slice(2)}.db`);
  db = await Effect.runPromise(open(dbPath));
  return db;
};

afterEach(async () => {
  if (db !== undefined) {
    await Effect.runPromiseExit(db.close);
    db = undefined;
  }
});

describe("records", () => {
  it("creates a record with a generated id", async () => {
    const db = await setup();
    const record = await Effect.runPromise(db.records.create({ data: { name: "alice" } }));
    expect(record.id).toMatch(/^rec_[0-9a-f]{32}$/);
    expect(record.data).toEqual({ name: "alice" });
    expect(record.labels).toEqual([]);
  });

  it("round-trips records through get", async () => {
    const db = await setup();
    const created = await Effect.runPromise(
      db.records.create({
        id: "rec_test123456789",
        data: { age: 30 },
        labels: ["person", "admin"],
      }),
    );
    const fetched = await Effect.runPromise(db.records.get("rec_test123456789"));
    expect(fetched.id).toEqual(created.id);
    expect(fetched.data).toEqual({ age: 30 });
    expect(fetched.labels).toEqual(["admin", "person"]);
    expect(fetched.createdAt).toBe(created.createdAt);
  });

  it("fails with NotFoundError for missing records", async () => {
    const db = await setup();
    const error = await Effect.runPromise(Effect.flip(db.records.get("rec_missing1111")));
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it("rejects malformed ids and labels", async () => {
    const db = await setup();
    const err1 = await Effect.runPromise(Effect.flip(db.records.get("bad id")));
    expect(err1).toBeInstanceOf(ValidationError);

    const err2 = await Effect.runPromise(
      Effect.flip(db.records.create({ data: {}, labels: ["bad label!"] })),
    );
    expect(err2).toBeInstanceOf(ValidationError);
  });

  it("conflicts on duplicate ids", async () => {
    const db = await setup();
    await Effect.runPromise(db.records.create({ id: "rec_dupe_00000001", data: {} }));
    const error = await Effect.runPromise(
      Effect.flip(db.records.create({ id: "rec_dupe_00000001", data: {} })),
    );
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("updates data and labels", async () => {
    const db = await setup();
    await Effect.runPromise(
      db.records.create({
        id: "rec_update_000001",
        data: { a: 1 },
        labels: ["alpha"],
      }),
    );
    const updated = await Effect.runPromise(
      db.records.update("rec_update_000001", {
        data: { b: 2 },
        addLabels: ["beta"],
        removeLabels: ["alpha"],
      }),
    );
    expect(updated.data).toEqual({ a: 1, b: 2 });
    expect(updated.labels).toEqual(["beta"]);
    expect(updated.updatedAt >= updated.createdAt).toBe(true);
  });

  it("deletes records atomically including incident relationships", async () => {
    const db = await setup();
    for (const id of ["rec_source_000001", "rec_target_000001"]) {
      await Effect.runPromise(db.records.create({ id, data: {}, labels: ["entity"] }));
    }
    const rel = await Effect.runPromise(
      db.relationships.create({
        type: "knows",
        sourceId: "rec_source_000001",
        targetId: "rec_target_000001",
      }),
    );
    await Effect.runPromise(db.records.delete("rec_source_000001"));

    const relErr = await Effect.runPromise(Effect.flip(db.relationships.get(rel.id)));
    expect(relErr).toBeInstanceOf(NotFoundError);

    const recErr = await Effect.runPromise(Effect.flip(db.records.get("rec_source_000001")));
    expect(recErr).toBeInstanceOf(NotFoundError);

    const survivors = await Effect.runPromise(db.records.listByLabels(["entity"]));
    expect(survivors.map((r) => r.id)).toEqual(["rec_target_000001"]);
  });

  it("lists by multiple labels", async () => {
    const db = await setup();
    await Effect.runPromise(
      Effect.all([
        db.records.create({ id: "rec_list_a_00001", labels: ["alpha", "beta"], data: {} }),
        db.records.create({ id: "rec_list_b_00001", labels: ["beta"], data: {} }),
        db.records.create({ id: "rec_list_c_00001", labels: ["alpha"], data: {} }),
      ]),
    );
    const both = await Effect.runPromise(db.records.listByLabels(["alpha", "beta"]));
    expect(both.map((r) => r.id)).toEqual(["rec_list_a_00001"]);
    const onlyAlpha = await Effect.runPromise(db.records.listByLabels(["alpha"]));
    expect(onlyAlpha.map((r) => r.id)).toEqual(["rec_list_a_00001", "rec_list_c_00001"]);
  });
});

describe("relationships", () => {
  it("creates, reads, and deletes relationships", async () => {
    const db = await setup();
    await Effect.all([
      db.records.create({ id: "rec_rel_src_000001", data: {} }),
      db.records.create({ id: "rec_rel_tgt_000001", data: {} }),
    ]).pipe(Effect.runPromise);

    const rel = await Effect.runPromise(
      db.relationships.create({
        id: "rel_fixed_id_000001",
        type: "likes",
        sourceId: "rec_rel_src_000001",
        targetId: "rec_rel_tgt_000001",
        properties: { weight: 0.5 },
      }),
    );
    expect(rel.createdAt).not.toBe("");
    const fetched = await Effect.runPromise(db.relationships.get("rel_fixed_id_000001"));
    expect(fetched.properties).toEqual({ weight: 0.5 });
    await Effect.runPromise(db.relationships.delete("rel_fixed_id_000001"));
    const err = await Effect.runPromise(Effect.flip(db.relationships.get("rel_fixed_id_000001")));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("rejects endpoints that do not exist", async () => {
    const db = await setup();
    const error = await Effect.runPromise(
      Effect.flip(
        db.relationships.create({
          type: "knows",
          sourceId: "rec_ghost_0000001",
          targetId: "rec_other_0000001",
        }),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("rejects invalid relationship types", async () => {
    const db = await setup();
    await Effect.all([
      db.records.create({ id: "rec_type_src_0001", data: {} }),
      db.records.create({ id: "rec_type_tgt_0001", data: {} }),
    ]).pipe(Effect.runPromise);
    const error = await Effect.runPromise(
      Effect.flip(
        db.relationships.create({
          type: "bad type!",
          sourceId: "rec_type_src_0001",
          targetId: "rec_type_tgt_0001",
        }),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("supports outgoing and incoming lookups with type filter", async () => {
    const db = await setup();
    await Effect.all([
      db.records.create({ id: "rec_hub_a_0000001", data: {} }),
      db.records.create({ id: "rec_hub_b_0000001", data: {} }),
      db.records.create({ id: "rec_leaf_x_000001", data: {} }),
      db.records.create({ id: "rec_leaf_y_000001", data: {} }),
    ]).pipe(Effect.runPromise);

    await Effect.runPromise(
      Effect.all([
        db.relationships.create({
          type: "link",
          sourceId: "rec_hub_a_0000001",
          targetId: "rec_leaf_x_000001",
        }),
        db.relationships.create({
          type: "loves",
          sourceId: "rec_hub_a_0000001",
          targetId: "rec_leaf_y_000001",
        }),
        db.relationships.create({
          type: "link",
          sourceId: "rec_leaf_y_000001",
          targetId: "rec_hub_b_0000001",
        }),
      ]),
    );

    const outAll = await Effect.runPromise(db.relationships.outgoing("rec_hub_a_0000001"));
    expect(outAll.map((r) => r.type).sort()).toEqual(["link", "loves"]);

    const outLink = await Effect.runPromise(db.relationships.outgoing("rec_hub_a_0000001", "link"));
    expect(outLink.map((r) => r.targetId)).toEqual(["rec_leaf_x_000001"]);

    const inAll = await Effect.runPromise(db.relationships.incoming("rec_hub_b_0000001"));
    expect(inAll.map((r) => r.sourceId)).toEqual(["rec_leaf_y_000001"]);
  });
});

describe("persistence", () => {
  it("survives close and reopen", async () => {
    const dbPath = join(dir, "persist.db");
    const first = await Effect.runPromise(open(dbPath));
    await Effect.runPromise(
      first.records.create({
        id: "rec_persist_00001",
        data: { key: "value" },
        labels: ["durable"],
      }),
    );
    await Effect.runPromise(first.close);

    const second = await Effect.runPromise(open(dbPath));
    const fetched = await Effect.runPromise(second.records.get("rec_persist_00001"));
    expect(fetched.data).toEqual({ key: "value" });
    expect(fetched.labels).toEqual(["durable"]);
    await Effect.runPromise(second.close);
  });
});
