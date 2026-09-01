import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/cheguersdb.js";
import type { CheguersDBHandle } from "../src/cheguersdb.js";
import { ValidationError } from "../src/errors.js";

let dir: string;
let db: CheguersDBHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cheguers-trav-"));
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

/**
 * Fixture graph (edges follow the chain direction):
 *
 *   a --LINK--> b --LINK--> c --LINK--> d --JUMP--> e
 */
const buildChain = async (): Promise<void> => {
  const ids = [
    "rec_trav_a_000001",
    "rec_trav_b_000001",
    "rec_trav_c_000001",
    "rec_trav_d_000001",
    "rec_trav_e_000001",
  ];
  for (const id of ids) {
    await Effect.runPromise(db!.records.create({ id, data: {} }));
  }
  for (const [src, tgt, type] of [
    ["rec_trav_a_000001", "rec_trav_b_000001", "link"],
    ["rec_trav_b_000001", "rec_trav_c_000001", "link"],
    ["rec_trav_c_000001", "rec_trav_d_000001", "link"],
    ["rec_trav_d_000001", "rec_trav_e_000001", "jump"],
  ] as const) {
    await Effect.runPromise(db!.relationships.create({ type, sourceId: src, targetId: tgt }));
  }
};

describe("bounded traversal", () => {
  it("follows outgoing chains up to maxDepth", async () => {
    const db = await setup();
    await buildChain();
    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing",
        relationshipTypes: ["link"],
        minDepth: 1,
        maxDepth: 3,
      }),
    );
    expect(result.hits.map((h) => h.record.id)).toEqual([
      "rec_trav_b_000001",
      "rec_trav_c_000001",
      "rec_trav_d_000001",
    ]);
    expect(result.hits.map((h) => h.depth)).toEqual([1, 2, 3]);
  });

  it("respects minDepth and type filters", async () => {
    const db = await setup();
    await buildChain();
    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing",
        relationshipTypes: ["jump"],
        minDepth: 1,
        maxDepth: 3,
      }),
    );
    // link chain a->b->c->d then jump d->e is not reachable because
    // intermediate hops require "link" only; with jump-only filtering nothing
    // beyond one hop of "jump" edges exists adjacent to start nodes.
    expect(result.hits).toEqual([]);
  });

  it("walks multiple relation types when unfiltered", async () => {
    const db = await setup();
    await buildChain();
    // Starting one hop in keeps the far node within the 3-hop bound.
    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_b_000001"],
        direction: "outgoing",
        maxDepth: 3,
      }),
    );
    const ids = result.hits.map((h) => h.record.id);
    expect(ids).toContain("rec_trav_e_000001");
  });

  it("supports incoming and both directions", async () => {
    const db = await setup();
    await buildChain();

    const incoming = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_d_000001"],
        direction: "incoming",
        maxDepth: 1,
      }),
    );
    expect(incoming.hits.map((h) => h.record.id)).toEqual(["rec_trav_c_000001"]);

    const both = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_c_000001"],
        direction: "both",
        maxDepth: 1,
      }),
    );
    expect(both.hits.map((h) => h.record.id).sort()).toEqual([
      "rec_trav_b_000001",
      "rec_trav_d_000001",
    ]);
  });

  it("handles cycles without looping", async () => {
    const db = await setup();
    for (const id of ["rec_trav_x_000001", "rec_trav_y_000001"]) {
      await Effect.runPromise(db.records.create({ id, data: {} }));
    }
    await Effect.all([
      db.relationships.create({
        type: "loop",
        sourceId: "rec_trav_x_000001",
        targetId: "rec_trav_y_000001",
      }),
      db.relationships.create({
        type: "loop",
        sourceId: "rec_trav_y_000001",
        targetId: "rec_trav_x_000001",
      }),
    ]).pipe(Effect.runPromise);

    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_x_000001"],
        direction: "both",
        maxDepth: 3,
      }),
    );
    const ids = result.hits.map((h) => h.record.id);
    expect(new Set([...ids, "rec_trav_x_000001"]).size).toBe(2);
    expect(ids).toEqual(["rec_trav_y_000001"]);
  });

  it("produces path provenance matching hit depths", async () => {
    const db = await setup();
    await buildChain();
    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing",
        minDepth: 1,
        maxDepth: 2,
        includePaths: true,
      }),
    );
    expect(result.paths).toBeDefined();
    const paths = result.paths!;
    expect(paths.length).toBe(result.hits.length);

    const depth2Idx = result.hits.findIndex((h) => h.depth === 2);
    const twoHopPath = paths[depth2Idx]!;
    expect(twoHopPath).toHaveLength(2);
    expect(twoHopPath[0]).toEqual({
      sourceId: "rec_trav_a_000001",
      targetId: "rec_trav_b_000001",
      type: "link",
    });
    expect(twoHopPath[1]!.targetId).toBe("rec_trav_c_000001");
  });

  it("enforces hop bounds and rejects invalid specs", async () => {
    const db = await setup();
    await buildChain();

    for (const badSpec of [
      {
        startIds: [],
        direction: "outgoing" as const,
      },
      {
        startIds: ["bad id!"],
        direction: "outgoing" as const,
      },
      {
        startIds: ["rec_trav_a_000001"],
        // SAFETY: test fixture supplies an intentionally invalid direction to assert rejection.
        direction: "diagonal" as never,
      },
      {
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing" as const,
        minDepth: 1,
        maxDepth: 7,
      },
      {
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing" as const,
        relationshipTypes: ["bad type!"],
      },
    ]) {
      const error = await Effect.runPromise(Effect.flip(db.traversal.traverse(badSpec)));
      expect(error).toBeInstanceOf(ValidationError);
    }
  });

  it("rejects missing start records", async () => {
    const db = await setup();
    await buildChain();
    const error = await Effect.runPromise(
      Effect.flip(
        db.traversal.traverse({
          startIds: ["rec_ghost_000000x"],
          direction: "both",
        }),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("caps results at the requested limit", async () => {
    const db = await setup();
    await buildChain();
    const result = await Effect.runPromise(
      db.traversal.traverse({
        startIds: ["rec_trav_a_000001"],
        direction: "outgoing",
        maxDepth: 3,
        limit: 2,
      }),
    );
    expect(result.hits.length).toBeLessThanOrEqual(2);
  });
});
