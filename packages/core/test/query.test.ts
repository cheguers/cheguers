import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/cheguersdb.js";
import type { CheguersDBHandle } from "../src/cheguersdb.js";
import type { JsonObject } from "../src/domain/model.js";

let dir: string;
let db: CheguersDBHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-query-"));
});

afterEach(async () => {
  if (db !== undefined) {
    await Effect.runPromiseExit(db.close);
    db = undefined;
  }
});

const setup = async (): Promise<CheguersDBHandle> => {
  const dbPath = join(dir, `q-${Math.random().toString(36).slice(2)}.db`);
  db = await Effect.runPromise(open(dbPath));
  return db;
};

interface Fixture {
  readonly id: string;
  readonly data: JsonObject;
  readonly labels: string[];
}

const fixtures: Fixture[] = [
  {
    id: "rec_q_alice_00001",
    data: { name: "alice", age: 30, city: "berlin", active: true },
    labels: ["person", "admin"],
  },
  {
    id: "rec_q_bob_000002",
    data: { name: "bob", age: 17, city: "paris", active: false },
    labels: ["person"],
  },
  {
    id: "rec_q_carol_00003",
    data: { name: "carol", age: 45, city: "berlin", email: "c@x.io" },
    labels: ["person"],
  },
  { id: "rec_q_post_0001", data: { title: "graph databases rock", views: 100 }, labels: ["post"] },
];

const seed = async (database: CheguersDBHandle): Promise<void> => {
  for (const f of fixtures) {
    await Effect.runPromise(
      database.records.create({
        id: f.id,
        data: f.data,
        labels: f.labels,
      }),
    );
  }
};

describe("query.find", () => {
  it("filters by label", async () => {
    const database = await setup();
    await seed(database);
    const rows = await Effect.runPromise(database.query.find({ labels: ["admin"] }));
    expect(rows.map((r) => r.id)).toEqual(["rec_q_alice_00001"]);
  });

  it("applies property comparison filters", async () => {
    const database = await setup();
    await seed(database);
    const adults = await Effect.runPromise(
      database.query.find({
        labels: ["person"],
        where: { property: "age", op: "gte", value: 18 },
        orderBy: [{ property: "age", direction: "asc" }],
      }),
    );
    expect(adults.map((r) => r.data.name)).toEqual(["alice", "carol"]);
  });

  it("supports logical and/or/not composition", async () => {
    const database = await setup();
    await seed(database);
    const rows = await Effect.runPromise(
      database.query.find({
        labels: ["person"],
        where: {
          or: [
            {
              and: [
                { property: "city", op: "eq", value: "berlin" },
                { property: "active", op: "eq", value: true },
              ],
            },
            { not: { property: "age", op: "lt", value: 40 } },
          ],
        },
        orderBy: [{ property: "name", direction: "asc" }],
      }),
    );
    expect(rows.map((r) => r.data.name)).toEqual(["alice", "carol"]);
  });

  it("supports in/contains/exists operators", async () => {
    const database = await setup();
    await seed(database);
    const cities = await Effect.runPromise(
      database.query.find({
        where: { property: "city", op: "in", value: ["berlin", "paris"] },
        orderBy: [{ property: "name", direction: "asc" }],
      }),
    );
    expect(cities).toHaveLength(3);

    const posts = await Effect.runPromise(
      database.query.find({
        labels: ["post"],
        where: { property: "title", op: "contains", value: "rock" },
      }),
    );
    expect(posts).toHaveLength(1);

    const withEmail = await Effect.runPromise(
      database.query.find({ where: { property: "email", op: "exists" } }),
    );
    expect(withEmail.map((r) => r.id)).toEqual(["rec_q_carol_00003"]);
  });

  it("paginates deterministically via public_id tie-breaking", async () => {
    const database = await setup();
    for (let i = 0; i < 10; i++) {
      await Effect.runPromise(database.records.create({ data: { n: i }, labels: ["num"] }));
    }
    const pageOne = await Effect.runPromise(
      database.query.find({
        labels: ["num"],
        limit: 4,
        orderBy: [{ property: "n", direction: "asc" }],
      }),
    );
    const pageTwo = await Effect.runPromise(
      database.query.find({
        labels: ["num"],
        limit: 4,
        offset: 4,
        orderBy: [{ property: "n", direction: "asc" }],
      }),
    );
    expect(pageOne.map((r) => r.data.n)).toEqual([0, 1, 2, 3]);
    expect(pageTwo.map((r) => r.data.n)).toEqual([4, 5, 6, 7]);
  });

  it("filters by one-hop related records composing with properties", async () => {
    const database = await setup();
    await seed(database);
    await Effect.runPromise(
      database.relationships.create({
        type: "authored",
        sourceId: "rec_q_alice_00001",
        targetId: "rec_q_post_0001",
      }),
    );
    const authorsOfPost = await Effect.runPromise(
      database.query.find({
        labels: ["person"],
        where: {
          related: {
            type: "authored",
            direction: "outgoing",
            where: { property: "views", op: "gt", value: 50 },
          },
        },
      }),
    );
    expect(authorsOfPost.map((r) => r.id)).toEqual(["rec_q_alice_00001"]);

    // incoming direction from post perspective
    const alicePosts = await Effect.runPromise(
      database.query.find({
        labels: ["post"],
        where: {
          related: {
            type: "authored",
            direction: "incoming",
            where: { property: "name", op: "eq", value: "alice" },
          },
        },
      }),
    );
    expect(alicePosts.map((r) => r.id)).toEqual(["rec_q_post_0001"]);
  });

  it("supports multi-hop related predicates up to 3 hops", async () => {
    const database = await setup();
    await seed(database);
    await Effect.runPromise(
      Effect.all([
        database.records.create({
          id: "rec_q_mid_000006",
          data: { role: "relay" },
        }),
        database.relationships.create({
          type: "authored",
          sourceId: "rec_q_alice_00001",
          targetId: "rec_q_post_0001",
        }),
        database.relationships.create({
          type: "authored",
          sourceId: "rec_q_carol_00003",
          targetId: "rec_q_mid_000006",
        }),
        database.relationships.create({
          type: "authored",
          sourceId: "rec_q_mid_000006",
          targetId: "rec_q_post_0001",
        }),
      ]),
    );
    // exactly 2 hops from carol: carol -authored-> mid -authored-> post(views=100)
    const found = await Effect.runPromise(
      database.query.find({
        where: {
          related: {
            type: "authored",
            direction: "outgoing",
            minHops: 2,
            maxHops: 2,
            where: { property: "views", op: "gte", value: 100 },
          },
        },
      }),
    );
    expect(found.map((r) => r.id)).toEqual(["rec_q_carol_00003"]);

    // one hop only matches the direct authors
    const oneHop = await Effect.runPromise(
      database.query.find({
        where: {
          related: {
            type: "authored",
            direction: "outgoing",
            maxHops: 1,
            where: { property: "views", op: "gte", value: 100 },
          },
        },
      }),
    );
    expect(oneHop.map((r) => r.id)).toEqual(["rec_q_alice_00001", "rec_q_mid_000006"]);
  });

  it("rejects invalid queries before execution", async () => {
    const database = await setup();
    await seed(database);
    const error = await Effect.runPromise(
      Effect.flip(
        database.query.find({
          // SAFETY: test fixture supplies an intentionally invalid operator to assert rejection.
          where: { property: "x", op: "regex" as never, value: "y" },
        }),
      ),
    );
    expect(error._tag).toEqual("ValidationError");
  });
});
