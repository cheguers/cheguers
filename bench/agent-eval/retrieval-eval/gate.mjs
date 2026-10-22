import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dataDir, seedsArg = "20", depthArg = "1"] = process.argv.slice(2);
const SEEDS = Number(seedsArg);
const DEPTH = Number(depthArg);
const TOP_N = 20;
const ALPHA = 0.6;
const BETA = 0.3;
const GAMMA = 0.1;
const DELTA = 0.85;

const readJsonl = (f) => readFileSync(join(dataDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const corpus = readJsonl("corpus.jsonl");
const edges = readJsonl("edges.jsonl");
const questions = readJsonl("questions_public.jsonl");
const gold = new Map(readJsonl("gold.jsonl").map((g) => [g.qid, g.gold]));

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const docVectors = new Map(readJsonl("vectors.jsonl").map((r) => [r.id, r.vector]));
const questionVectors = new Map(readJsonl("question_vectors.jsonl").map((r) => [r.qid, r.vector]));
const docs = corpus.map((r) => ({ id: r.id, vec: docVectors.get(r.id) }));
const adj = new Map();
const addAdj = (from, to, type) => {
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push({ to, type });
};
for (const e of edges) {
  addAdj(e.from, e.to, e.type);
  addAdj(e.to, e.from, e.type);
}

const vectorOnly = (qvec) =>
  docs
    .map((d) => ({ id: d.id, s: dot(qvec, d.vec) }))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
    .slice(0, SEEDS);

const hybrid = (seeds) => {
  const best = new Map();
  const minDepth = new Map();
  const seedSet = new Map();
  const seedCount = seeds.length;
  for (const s of seeds) {
    const contrib = Math.max(0, s.s);
    best.set(s.id, Math.max(best.get(s.id) ?? 0, contrib));
    minDepth.set(s.id, 0);
    seedSet.set(s.id, new Set([s.id]));
  }
  let frontier = seeds.map((s) => ({ seed: s.id, node: s.id, factor: 1 }));
  for (let level = 1; level <= DEPTH; level++) {
    const next = [];
    const expanded = new Set();
    for (const state of frontier) {
      for (const { to } of adj.get(state.node) ?? []) {
        const key = `${state.seed}|${to}`;
        if (expanded.has(key)) continue;
        expanded.add(key);
        const seedContrib = seeds.find((x) => x.id === state.seed).s;
        const contrib = Math.max(0, seedContrib) * DELTA ** level * state.factor;
        best.set(to, Math.max(best.get(to) ?? 0, contrib));
        minDepth.set(to, Math.min(minDepth.get(to) ?? Infinity, level));
        if (!seedSet.has(to)) seedSet.set(to, new Set());
        seedSet.get(to).add(state.seed);
        next.push({ seed: state.seed, node: to, factor: state.factor });
      }
    }
    frontier = next;
  }
  const total = ALPHA + BETA + GAMMA;
  const scored = [...best.keys()].map((id) => {
    const md = minDepth.get(id);
    const a = seedSet.get(id).size;
    const score =
      (ALPHA / total) * best.get(id) +
      (BETA / total) * (1 / (1 + md)) +
      (GAMMA / total) * Math.min(1, a / seedCount);
    return { id, s: score };
  });
  return scored.sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
};

const recall = (ranked, goldIds) => {
  const top = new Set(ranked.slice(0, TOP_N).map((x) => x.id));
  return goldIds.filter((g) => top.has(g)).length / goldIds.length;
};

const byStratum = new Map();
for (const q of questions) {
  const qvec = questionVectors.get(q.qid);
  const seeds = vectorOnly(qvec);
  const vec = recall(seeds, gold.get(q.qid));
  const hyb = recall(hybrid(seeds), gold.get(q.qid));
  const row = byStratum.get(q.stratum) ?? { n: 0, vec: 0, hyb: 0 };
  row.n += 1;
  row.vec += vec;
  row.hyb += hyb;
  byStratum.set(q.stratum, row);
}

console.log(`seeds=${SEEDS} depth=${DEPTH} top_n=${TOP_N} dim=384`);
console.log("stratum  n   vector_recall  hybrid_recall");
for (const [s, r] of [...byStratum.entries()].sort()) {
  console.log(`${s.padEnd(8)} ${String(r.n).padEnd(3)} ${(r.vec / r.n).toFixed(3).padEnd(14)} ${(r.hyb / r.n).toFixed(3)}`);
}
