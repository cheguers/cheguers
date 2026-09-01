import { readFileSync } from "node:fs";
import {
  isJsonArray,
  isNumberValue,
  isPlainObject,
  isStringValue,
  open,
  parseJsonObject,
  parseJsonValue,
  type JsonValue,
} from "@cheguers/core";

// Usage:
//   tsx scripts/shakespeare-rag.ts ingest shakespeare.db chunks.jsonl
//   tsx scripts/shakespeare-rag.ts embed "to be or not to be"
//
// chunks.jsonl lines: {"play":"Hamlet","act":1,"scene":2,"text":"..."}
// Embeddings: OpenAI text-embedding-3-small if OPENAI_API_KEY is set,
// otherwise a deterministic local hash embedding (dim 256) so the demo
// works offline.

const DIM = 256;

interface ChunkRow {
  readonly play: string;
  readonly act: number;
  readonly scene: number;
  readonly text: string;
}

const parseChunkRow = (value: JsonValue, line: number): ChunkRow => {
  const obj = parseJsonObject(value, `line ${line} must be a JSON object`);
  if (!isStringValue(obj.play)) throw new Error(`line ${line}: play must be a string`);
  if (!isNumberValue(obj.act)) throw new Error(`line ${line}: act must be a number`);
  if (!isNumberValue(obj.scene)) throw new Error(`line ${line}: scene must be a number`);
  if (!isStringValue(obj.text)) throw new Error(`line ${line}: text must be a string`);
  return { play: obj.play, act: obj.act, scene: obj.scene, text: obj.text };
};

const parseEmbeddingVector = (value: JsonValue, index: number): number[] => {
  if (!isJsonArray(value)) throw new Error(`embedding ${index} must be an array`);
  const vector: number[] = [];
  for (const entry of value) {
    if (!isNumberValue(entry)) throw new Error(`embedding ${index} must contain numbers`);
    vector.push(entry);
  }
  return vector;
};

const parseEmbeddingsResponse = (value: JsonValue): Array<{ embedding: number[] }> => {
  const obj = parseJsonObject(value, "OpenAI embeddings response must be an object");
  if (!isJsonArray(obj.data)) throw new Error("OpenAI embeddings response missing data array");
  return obj.data.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`OpenAI embeddings response entry ${index} must be an object`);
    }
    return { embedding: parseEmbeddingVector(entry.embedding, index) };
  });
};

const hashEmbed = (text: string): number[] => {
  const v = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

const openAIEmbed = async (texts: string[]): Promise<number[][]> => {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  const json = parseEmbeddingsResponse(
    parseJsonValue(await res.json(), "OpenAI embeddings response"),
  );
  return json.map((d) => d.embedding);
};

const chunkText = (text: string, size = 900): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const mode = process.argv[2];

if (mode === "embed") {
  const question = process.argv[3] ?? "";
  const vector = process.env.OPENAI_API_KEY
    ? (await openAIEmbed([question]))[0]
    : hashEmbed(question);
  console.log(vector.join(","));
  process.exit(0);
}

if (mode === "ingest") {
  const dbPath = process.argv[3];
  const file = process.argv[4];
  if (!dbPath || !file) {
    console.error("usage: tsx scripts/shakespeare-rag.ts ingest <db> <chunks.jsonl>");
    process.exit(2);
  }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const rows = lines.map((line, index) =>
    parseChunkRow(
      parseJsonValue(JSON.parse(line), `line ${index + 1} must be valid JSON`),
      index + 1,
    ),
  );

  const chunks = rows.flatMap((row) =>
    chunkText(row.text).map((text, part) => ({
      data: {
        text,
        play: row.play,
        act: row.act,
        scene: row.scene,
        part,
        citation: `${row.play} Act ${row.act}, Scene ${row.scene}`,
      },
      labels: ["scene", row.play.toLowerCase().replace(/[^a-z0-9]+/g, "_")],
    })),
  );
  console.error(`ingesting ${chunks.length} chunks...`);

  const db = await import("effect").then(({ Effect }) => Effect.runPromise(open(dbPath)));
  const { Effect } = await import("effect");
  const created = await Effect.runPromise(db.bulk.createRecords(chunks));
  console.error(`created ${created.length} records, embedding...`);

  const vectors = process.env.OPENAI_API_KEY
    ? await openAIEmbed(chunks.map((c) => c.data.text))
    : chunks.map((c) => hashEmbed(c.data.text));

  await Effect.runPromise(
    db.bulk.upsertVectors(
      created.map((rec, i) => ({
        recordId: rec.id,
        namespace: "text",
        vector: vectors[i]!,
      })),
    ),
  );
  console.error(`upserted ${vectors.length} vectors (namespace "text")`);
  await Effect.runPromise(db.close);
  process.exit(0);
}

console.error("usage: tsx scripts/shakespeare-rag.ts <ingest|embed> [args]");
process.exit(2);
