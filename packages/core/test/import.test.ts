import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { open } from "../src/cheguersdb.js";
import type { JsonObject, JsonValue } from "../src/domain/model.js";

const openEffect = () =>
  Effect.runPromise(open(join(mkdtempSync(join(tmpdir(), "cheguers-import-")), "test.db")));

type InvalidImportRoot = JsonValue | undefined;

const runImportUnchecked = (
  db: Awaited<ReturnType<typeof openEffect>>,
  input: InvalidImportRoot,
) => {
  // SAFETY: test passes intentionally invalid roots to assert ValidationError.
  return db.imports.run(input as JsonObject);
};

describe("nested import", () => {
  it("imports nested JSON into records, labels, and relationships atomically", async () => {
    const db = await openEffect();
    const result = await Effect.runPromise(
      db.imports.run(
        {
          title: "post-1",
          views: 12,
          tags: ["x", "y"],
          author: { name: "alice" },
          comments: [{ body: "nice" }, { body: "more" }],
        },
        { rootLabels: ["post"] },
      ),
    );
    expect(result.recordsCreated).toBe(4);
    expect(result.relationshipsCreated).toBe(3);
    expect(Object.keys(result.idsByLocalId).sort()).toEqual([
      "root",
      "root.author",
      "root.comments.0",
      "root.comments.1",
    ]);

    const root = await Effect.runPromise(db.records.get(result.rootId));
    expect(root.labels).toEqual(["post"]);
    expect(root.data).toEqual({ title: "post-1", views: 12, tags: ["x", "y"] });

    const children = await Effect.runPromise(db.relationships.outgoing(result.rootId));
    expect(children.map((r) => r.type).sort()).toEqual(["author", "comments", "comments"]);
    await Effect.runPromiseExit(db.close);
  });

  it("produces deterministic record data for identical inputs", async () => {
    const input = {
      a: { b: { c: 1 } },
      list: [{ k: 2 }, { k: 3 }],
    };
    const first = await openEffect();
    const second = await openEffect();
    const r1 = await Effect.runPromise(first.imports.run(input));
    const r2 = await Effect.runPromise(second.imports.run(input));
    const root1 = await Effect.runPromise(first.records.get(r1.rootId));
    const root2 = await Effect.runPromise(second.records.get(r2.rootId));
    expect(root1.data).toEqual(root2.data);
    expect(root2.labels).toEqual([]);
    await Effect.runPromiseExit(first.close);
    await Effect.runPromiseExit(second.close);
  });

  it("rejects non-object roots as ValidationError", async () => {
    const db = await openEffect();
    for (const bad of [null, undefined, [1, 2], "text", 42, true]) {
      const exit = await Effect.runPromiseExit(runImportUnchecked(db, bad));
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.findErrorOption(exit);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("ValidationError");
      }
    }
    await Effect.runPromiseExit(db.close);
  });
});
