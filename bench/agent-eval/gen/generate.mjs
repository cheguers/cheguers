import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir = "out", seedArg = "1", perStratumArg = "5"] = process.argv.slice(2);
const seed = Number(seedArg);
const perStratum = Number(perStratumArg);
const SIZES = { papers: 1400, authors: 700, orgs: 80, venues: 40 };


const TOPIC_SYN = {
  "graph partitioning": "splitting large networks into balanced subgraphs",
  "sparse attention": "attending only to a selected subset of tokens",
  "query planning": "choosing an execution strategy for database queries",
  "vector quantization": "compressing embedding vectors into compact codes",
  "causal inference": "estimating cause and effect from observational data",
  "program synthesis": "automatically generating programs from specifications",
  "entity linking": "mapping mentions in text to knowledge base entries",
  "retrieval caching": "reusing previously fetched search results",
  "federated learning": "training models across decentralized data holders",
  "differential privacy": "releasing statistics with formal privacy guarantees",
  "schema matching": "aligning fields between two database layouts",
  "time-series compression": "shrinking sequences of timestamped measurements",
  "log anomaly detection": "spotting unusual entries in system logs",
  "memory consolidation": "moving short-term recollections into long-term storage",
  "tool use": "letting a model call external programs",
  "knowledge distillation": "transferring a large teacher model's behaviour to a small student",
  "contrastive pretraining": "learning representations by pulling matched pairs together",
  "constraint solving": "finding assignments that satisfy logical restrictions",
  "stream joins": "combining two unbounded data feeds on matching keys",
  "citation recommendation": "suggesting references a manuscript should cite",
};
const SETTING_SYN = {
  "embedded systems": "resource-constrained microcontroller platforms",
  "clinical records": "hospital patient documentation",
  "legal documents": "court filings and contracts",
  "edge devices": "devices at the network periphery such as sensors",
  "scientific corpora": "collections of research articles",
  "open-source repositories": "publicly hosted code projects",
  "financial reports": "company earnings disclosures",
  "multilingual data": "text written in many languages",
};
const MODIFIER_SYN = {
  scalable: "able to grow to very large workloads",
  robust: "resistant to noisy or adversarial inputs",
  adaptive: "self-adjusting to changing conditions",
  efficient: "economical in compute and memory",
  lightweight: "small in footprint",
  incremental: "updated one step at a time",
  "provably correct": "with a formal correctness proof",
  "low-latency": "responding in very little time",
  distributed: "spread across many machines",
  compact: "occupying little space",
  interpretable: "whose decisions a human can inspect",
  streaming: "processing data as it arrives",
  resilient: "recovering quickly from faults",
  modular: "built from interchangeable parts",
  "privacy-preserving": "keeping individual records hidden",
  "self-tuning": "choosing its own parameters",
  approximate: "trading exactness for speed",
  hierarchical: "organized in levels",
  parallel: "running many workers at once",
  verifiable: "whose outputs can be checked",
  sparse: "using mostly zero values",
  "bounded-memory": "with a fixed memory ceiling",
  "cost-aware": "optimizing monetary cost",
  "multi-tenant": "serving several isolated customers",
  "zero-shot": "without task-specific training",
  explainable: "giving reasons for its outputs",
  online: "learning from a continuous feed",
  lossless: "reconstructing the input exactly",
  hybrid: "combining two complementary techniques",
  "energy-aware": "minimizing power draw",
};
const describe = (p) => `a paper about ${TOPIC_SYN[p.topic]} for ${SETTING_SYN[p.setting]} that is ${MODIFIER_SYN[p.modifier]}`;
const rnd = mulberry32(seed);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n) => String(n).padStart(4, "0");
const sample = (n, xs) => {
  const chosen = new Set();
  const want = Math.min(n, xs.length);
  while (chosen.size < want) chosen.add(pick(xs));
  return [...chosen];
};

function mulberry32(a) {
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  "graph partitioning", "sparse attention", "query planning", "vector quantization",
  "causal inference", "program synthesis", "entity linking", "retrieval caching",
  "federated learning", "differential privacy", "schema matching", "time-series compression",
  "log anomaly detection", "memory consolidation", "tool use", "knowledge distillation",
  "contrastive pretraining", "constraint solving", "stream joins", "citation recommendation",
];
const MODIFIERS = [
  "scalable", "robust", "adaptive", "efficient", "lightweight", "incremental",
  "provably correct", "low-latency", "distributed", "compact", "interpretable", "streaming",
  "resilient", "modular", "privacy-preserving", "self-tuning", "approximate", "hierarchical",
  "parallel", "verifiable", "sparse", "bounded-memory", "cost-aware", "multi-tenant",
  "zero-shot", "explainable", "online", "lossless", "hybrid", "energy-aware",
];
const SETTINGS = [
  "embedded systems", "clinical records", "legal documents", "edge devices",
  "scientific corpora", "open-source repositories", "financial reports", "multilingual data",
];
const FIRST = ["Maria", "Jonas", "Aiko", "Samir", "Lena", "Tomas", "Priya", "Diego", "Yara", "Felix", "Nadia", "Owen", "Chloe", "Ravi", "Ines", "Kofi"];
const LAST = ["Chen", "Okafor", "Lindqvist", "Haddad", "Moreau", "Kowalski", "Tanaka", "Silva", "Nakamura", "Brandt", "Costa", "Mensah", "Petrov", "Duarte", "Ibrahim", "Novak"];
const INITIALS = "ABCDEFGHIJKLMNOPRSTUVW".split("");
const ORG_STEMS =["Halden", "Northwind", "Verity", "Ostrava", "Calder", "Sable", "Brightwater", "Kestrel", "Morrow", "Tessera"];
const ORG_SUFFIX = ["Labs", "Institute", "Research Group", "Analytics", "Systems"];
const VENUE_KIND = ["Symposium", "Workshop", "Conference"];
const VENUE_TOPIC = ["Data Systems", "Learning Infrastructure", "Knowledge Engineering", "Information Retrieval", "Software Foundations"];

function nearVariant(s) {
  const idx = [...s].map((c, i) => ("aeiou".includes(c.toLowerCase()) ? i : -1)).filter((i) => i > 0);
  if (idx.length === 0) return `${s}e`;
  const i = pick(idx);
  const alt = pick("aeiou".split("").filter((v) => v !== s[i].toLowerCase()));
  return s.slice(0, i) + alt + s.slice(i + 1);
}

function buildUnique(n, make, key) {
  const seen = new Set();
  const items = [];
  while (items.length < n) {
    const value = make(items);
    if (seen.has(key(value))) continue;
    seen.add(key(value));
    items.push(value);
  }
  return items;
}

const orgs = buildUnique(
  SIZES.orgs,
  (xs) => ({
    name: xs.length > 10 && rnd() < 0.3 ? nearVariant(pick(xs).name) : `${pick(ORG_STEMS)} ${pick(ORG_SUFFIX)}`,
  }),
  (v) => v.name,
).map((v, i) => ({ id: `org_${pad(i + 1)}`, label: "organization", name: v.name }));

const venues = buildUnique(
  SIZES.venues,
  () => ({ name: `${pick(VENUE_KIND)} on ${pick(VENUE_TOPIC)} ${int(2010, 2024)}` }),
  (v) => v.name,
).map((v, i) => ({ id: `venue_${pad(i + 1)}`, label: "venue", name: v.name }));

const authors = buildUnique(
  SIZES.authors,
  (xs) => ({
    name: xs.length > 10 && rnd() < 0.2
      ? `${pick(xs).name.split(" ")[0]} ${pick(INITIALS)}. ${pick(LAST)}`
      : `${pick(FIRST)} ${pick(INITIALS)}. ${pick(LAST)}`,
  }),
  (v) => v.name,
).map((v, i) => ({ id: `author_${pad(i + 1)}`, label: "author", name: v.name }));

const papers = buildUnique(
  SIZES.papers,
  (xs) => {
    const near = xs.length > 5 && rnd() < 0.25;
    const base = near ? pick(xs) : null;
    const topic = near ? base.topic : pick(TOPICS);
    const setting = near ? base.setting : pick(SETTINGS);
    const modifier = pick(MODIFIERS);
    return { topic, setting, modifier, title: `${modifier[0].toUpperCase()}${modifier.slice(1)} ${topic} for ${setting}` };
  },
  (v) => v.title,
).map((v, i) => ({
  id: `paper_${pad(i + 1)}`,
  label: "paper",
  title: v.title,
  topic: v.topic,
  setting: v.setting,
  modifier: v.modifier,
  year: int(2016, 2026),
  text: "",
}));

const edges = [];
const addEdge = (type, from, to) => edges.push({ id: `rel_${String(edges.length + 1).padStart(6, "0")}`, type, from, to });

for (const a of authors) {
  for (const o of sample(rnd() < 0.15 ? 2 : 1, orgs)) addEdge("AFFILIATED_WITH", a.id, o.id);
}
papers.forEach((p, i) => {
  addEdge("PRESENTED_AT", p.id, pick(venues).id);
  for (const a of sample(int(1, 3), authors)) addEdge("AUTHORED_BY", p.id, a.id);
  if (i > 0) for (const c of sample(Math.min(int(1, 4), i), papers.slice(0, i))) addEdge("CITES", p.id, c.id);
});

const targets = (type, from) => edges.filter((e) => e.type === type && e.from === from).map((e) => e.to);
const byId = new Map([...papers, ...authors, ...orgs, ...venues].map((r) => [r.id, r]));
const joinList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const nameOf = (id) => byId.get(id).name ?? byId.get(id).title;
for (const o of orgs) o.text = `${o.name} is a research organization.`;
for (const v of venues) v.text = `${v.name} is a venue for research papers.`;
for (const a of authors) {
  const orgNames = targets("AFFILIATED_WITH", a.id).map(nameOf);
  a.text = `${a.name} is affiliated with ${joinList(orgNames)}.`;
}
for (const p of papers) {
  const venue = nameOf(targets("PRESENTED_AT", p.id)[0]);
  const authorNames = targets("AUTHORED_BY", p.id).map(nameOf);
  const cited = targets("CITES", p.id).map(nameOf);
  const citeSentence = cited.length ? ` It cites ${joinList(cited)}.` : "";
  p.text = `${p.title}. We study ${p.topic} in ${p.setting}. Keywords: ${p.topic}, ${p.setting}. This paper was presented at ${venue}. Its authors are ${joinList(authorNames)}.${citeSentence}`;
}

const sources = (type, to) => edges.filter((e) => e.type === type && e.to === to).map((e) => e.from);
const uniqSorted = (xs) => [...new Set(xs)].sort();

const questions = [];
const addQuestion = (stratum, hops, question, gold, path, paperId) =>
  questions.push({ stratum, hops, question, gold: uniqSorted(gold), path, paperId });

for (const p of sample(perStratum, papers)) {
  addQuestion(
    "hop0", 0,
    `Which paper matches this description: ${describe(p)}? Give its paper id.`,
    [p.id],
    "paper (text match only)",
    p.id,
  );
}
for (const p of sample(perStratum, papers)) {
  const venue = targets("PRESENTED_AT", p.id)[0];
  addQuestion(
    "hop1", 1,
    `Which venue was ${describe(p)} presented at? Give the venue id.`,
    [venue],
    "paper -PRESENTED_AT-> venue",
    p.id,
  );
}
for (const p of sample(perStratum, papers)) {
  const orgIds = uniqSorted(targets("AUTHORED_BY", p.id).flatMap((a) => targets("AFFILIATED_WITH", a)));
  addQuestion(
    "hop2", 2,
    `List the ids of every organization affiliated with an author of ${describe(p)}.`,
    orgIds,
    "paper -AUTHORED_BY-> author -AFFILIATED_WITH-> org",
    p.id,
  );
}
const citers = papers.filter((p) => targets("CITES", p.id).length > 0);
for (const p of sample(perStratum, citers)) {
  const orgIds = uniqSorted(
    targets("CITES", p.id).flatMap((c) => targets("AUTHORED_BY", c)).flatMap((a) => targets("AFFILIATED_WITH", a)),
  );
  addQuestion(
    "hop3", 3,
    `List the ids of every organization affiliated with an author of any paper cited by ${describe(p)}.`,
    orgIds,
    "paper -CITES-> paper -AUTHORED_BY-> author -AFFILIATED_WITH-> org",
    p.id,
  );
}
const filterCandidates = [];
for (let attempt = 0; attempt < 2000 && filterCandidates.length < perStratum * 4; attempt++) {
  const v = pick(venues);
  const o = pick(orgs);
  const gold = sources("PRESENTED_AT", v.id).filter((pid) =>
    targets("AUTHORED_BY", pid).some((a) => targets("AFFILIATED_WITH", a).includes(o.id)),
  );
  if (gold.length >= 1 && gold.length <= 8) filterCandidates.push({ v, o, gold });
}
for (const c of sample(perStratum, filterCandidates)) {
  addQuestion(
    "filter", 2,
    `List the ids of the papers presented at "${c.v.name}" that have an author affiliated with "${c.o.name}".`,
    c.gold,
    "venue(name filter) <-PRESENTED_AT- paper -AUTHORED_BY-> author -AFFILIATED_WITH-> org(name filter)",
  );
}

const verify = () => {
  for (const q of questions.filter((x) => x.stratum === "hop2")) {
    const p = papers.find((x) => x.id === q.paperId);
    const authorsOf = edges.filter((e) => e.type === "AUTHORED_BY" && e.from === p.id).map((e) => e.to);
    const recomputed = uniqSorted(edges.filter((e) => e.type === "AFFILIATED_WITH" && authorsOf.includes(e.from)).map((e) => e.to));
    const expected = uniqSorted(authorsOf.flatMap((a) => targets("AFFILIATED_WITH", a)));
    if (JSON.stringify(recomputed) !== JSON.stringify(expected)) throw new Error(`verify mismatch for ${p.id}`);
  }
  for (const q of questions.filter((x) => x.stratum === "filter")) {
    if (q.gold.length === 0) throw new Error("empty filter gold");
  }
};
verify();

const withIds = questions.map((q, i) => ({ qid: `${q.stratum}_${pad(i + 1)}`, ...q }));
const records = [...papers, ...authors, ...orgs, ...venues].map((r) => {
  const { label, ...rest } = r;
  return { id: rest.id, labels: [label], data: Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "id" && k !== "text")), text: rest.text ?? rest.name };
});

const recordById = new Map(records.map((r) => [r.id, r]));
const supportIds = (q) => {
  const ids = new Set();
  const authorsAndOrgs = (pid) =>
    targets("AUTHORED_BY", pid).forEach((a) => {
      ids.add(a);
      targets("AFFILIATED_WITH", a).forEach((o) => ids.add(o));
    });
  const add = (x) => ids.add(x);
  if (q.stratum === "filter") {
    for (const g of q.gold) {
      add(g);
      targets("PRESENTED_AT", g).forEach(add);
      authorsAndOrgs(g);
    }
  } else {
    add(q.paperId);
    if (q.stratum === "hop1") targets("PRESENTED_AT", q.paperId).forEach(add);
    if (q.stratum === "hop2") authorsAndOrgs(q.paperId);
    if (q.stratum === "hop3")
      targets("CITES", q.paperId).forEach((c) => {
        add(c);
        authorsAndOrgs(c);
      });
  }
  for (const g of q.gold) if (!ids.has(g)) throw new Error(`support for ${q.qid} misses gold ${g}`);
  return [...ids].sort();
};
mkdirSync(outDir, { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(outDir, "corpus.jsonl"), jsonl(records));
writeFileSync(join(outDir, "edges.jsonl"), jsonl(edges));
writeFileSync(join(outDir, "questions_public.jsonl"), jsonl(withIds.map(({ gold, path, paperId, ...q }) => q)));
writeFileSync(join(outDir, "support.jsonl"), jsonl(withIds.map((q) => ({ qid: q.qid, stratum: q.stratum, records: supportIds(q).map((id) => recordById.get(id)) }))));
writeFileSync(join(outDir, "gold.jsonl"), jsonl(withIds.map((q) => ({ qid: q.qid, stratum: q.stratum, gold: q.gold, path: q.path }))));

const sha = (file) => createHash("sha256").update(file).digest("hex");
writeFileSync(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      seed,
      perStratum,
      records: records.length,
      edges: edges.length,
      questions: withIds.length,
      strata: Object.fromEntries(["hop0", "hop1", "hop2", "hop3", "filter"].map((s) => [s, withIds.filter((q) => q.stratum === s).length])),
      sha256: {
        corpus: sha(jsonl(records)),
        edges: sha(jsonl(edges)),
        gold: sha(jsonl(withIds.map((q) => ({ qid: q.qid, gold: q.gold })))),
        support: sha(jsonl(withIds.map((q) => ({ qid: q.qid, stratum: q.stratum, records: supportIds(q).map((id) => recordById.get(id)) })))),
      },
    },
    null,
    2,
  ) + "\n",
);
