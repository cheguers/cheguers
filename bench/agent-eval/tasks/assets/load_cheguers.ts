import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { open } from "@cheguers/core";

const [storeDir, dbPath] = process.argv.slice(2);

const readJsonl = (f: string) =>
  readFileSync(join(storeDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const corpus = readJsonl("corpus.jsonl");
const edges = readJsonl("edges.jsonl");
const vectors = new Map(
  readFileSync(join(storeDir, "vectors.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
    const row = JSON.parse(l);
    return [row.id, row.vector as number[]] as const;
  }),
);

const program = Effect.gen(function* () {
  const db = yield* open(dbPath);
  yield* db.bulk.createRecords(
    corpus.map((r: { id: string; labels: string[]; data: object; text: string }) => ({
      id: r.id,
      labels: r.labels,
      data: { ...r.data, text: r.text },
    })),
  );
  yield* db.bulk.createRelationships(
    edges.map((e: { type: string; from: string; to: string }) => ({
      type: e.type,
      sourceId: e.from,
      targetId: e.to,
    })),
  );
  yield* db.bulk.upsertVectors(
    corpus.map((r: { id: string; text: string }) => ({
      recordId: r.id,
      vector: vectors.get(r.id)!,
    })),
  );
  yield* db.close;
  console.log(`loaded ${corpus.length} records, ${edges.length} edges into ${dbPath}`);
});

Effect.runPromise(program);
