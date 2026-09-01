import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/cheguersdb.js";
import type { CheguersDBHandle } from "../src/cheguersdb.js";

let dir: string;
let db: CheguersDBHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-schema-"));
});

afterEach(async () => {
  if (db !== undefined) {
    await Effect.runPromiseExit(db.close);
    db = undefined;
  }
});

const setup = async (): Promise<CheguersDBHandle> => {
  const dbPath = join(dir, `schema-${Math.random().toString(36).slice(2)}.db`);
  db = await Effect.runPromise(open(dbPath));
  return db;
};

describe("schema inference", () => {
  it("infers types on create and accumulates observations", async () => {
    const db = await setup();
    await Effect.runPromise(
      db.records.create({
        id: "rec_schema_a_0001",
        data: { name: "alice", age: 30, active: true },
        labels: ["person"],
      }),
    );
    await Effect.runPromise(
      db.records.create({
        id: "rec_schema_b_0002",
        data: { name: "bob", age: 41 },
        labels: ["person"],
      }),
    );
    const entries = await Effect.runPromise(db.schema.introspect({ label: "person" }));
    const byProperty = Object.fromEntries(entries.map((e) => [e.property, e]));
    expect(byProperty.name?.inferredType).toEqual("string");
    expect(byProperty.age?.inferredType).toEqual("number");
    expect(byProperty.active?.inferredType).toEqual("boolean");
    expect(byProperty.name?.observations).toEqual(2);
    expect(byProperty.active?.observations).toEqual(1);
  });

  it("recognizes datetimes and reconciles conflicting types", async () => {
    const db = await setup();
    await Effect.runPromise(
      db.records.create({
        id: "rec_schema_c_0003",
        data: { when: "2026-01-01T00:00:00Z", score: 5 },
        labels: ["event"],
      }),
    );
    await Effect.runPromise(
      db.records.create({
        id: "rec_schema_d_0004",
        data: { when: "not a date", score: null },
        labels: ["event"],
      }),
    );
    const entries = await Effect.runPromise(db.schema.introspect({ label: "event" }));
    const byProperty = Object.fromEntries(entries.map((e) => [e.property, e]));
    expect(byProperty.when?.inferredType).toEqual("datetime");
    expect(byProperty.score?.inferredType).toEqual("number");
  });

  it("never mutates canonical user JSON", async () => {
    const db = await setup();
    await Effect.runPromise(
      db.records.create({
        id: "rec_schema_e_0005",
        data: { nested: { a: 1 }, list: [{ b: 2 }] },
        labels: ["thing"],
      }),
    );
    const record = await Effect.runPromise(db.records.get("rec_schema_e_0005"));
    expect(record.data).toEqual({
      nested: { a: 1 },
      list: [{ b: 2 }],
    });
  });

  it("rejects invalid label filters", async () => {
    const db = await setup();
    const error = await Effect.runPromise(
      Effect.flip(db.schema.introspect({ label: "bad label!" })),
    );
    expect(error).toBeInstanceOf((await import("../src/errors.js")).ValidationError);
  });
});
