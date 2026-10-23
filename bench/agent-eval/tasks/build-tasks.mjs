import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [genRoot, outRoot, seedsArg = "1,2,3,4,5,6"] = process.argv.slice(2);
const assets = fileURLToPath(new URL("./assets/", import.meta.url));
const seeds = seedsArg.split(",").map(Number);
const STRATA = ["hop0", "hop1", "hop2", "hop3", "filter"];
const TASK_GUID = "5f0c2a7e-4b1d-4e8a-9c3b-2d7e6a1f0b94";

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const DESCRIPTIONS = {
  hop0: "a paper described by its topic, setting and modifier",
  hop1: "the venue of a paper found by its title",
  hop2: "organizations reached from a paper through its authors",
  hop3: "organizations reached through the papers a paper cites",
  filter: "papers filtered by venue name and author affiliation",
};

const DEFAULT_LEAD = [
  "A knowledge base about research papers, authors, organizations and venues is available to you, as described in the instructions above.",
  "- /app/data/embed.py: `python3 /app/data/embed.py \"<text>\"` prints a 384-dimension sentence embedding (all-MiniLM-L6-v2).",
  "",
  "Answer every question below using only this data. Write /app/answer.json as one JSON object that maps each question id to the list of record ids that answer it (use [] when there are none).",
];
const GOLD_LEAD = [
  "The records that support each question below are in /app/data/support.jsonl. Each line is one JSON object with qid, stratum and records.",
  "Answer every question below using only these records. Write /app/answer.json as one JSON object that maps each question id to the list of record ids that answer it (use [] when there are none).",
];
const CLOSED_LEAD = [
  "No knowledge base is available for this task. Answer every question below from your own knowledge only, and do not search the filesystem for data.",
  "Write /app/answer.json as one JSON object that maps each question id to the list of record ids that answer it (use [] when you do not know).",
];

const instructionFor = (questions, lead = DEFAULT_LEAD) =>
  [...lead, "", ...questions.map((q) => `${q.qid}: ${q.question}`)].join("\n");

const taskYaml = (id, stratum, questions, lead = DEFAULT_LEAD) => {
  const body = instructionFor(questions, lead)
    .split("\n")
    .map((l) => (l === "" ? "" : `  ${l}`))
    .join("\n");
  return [
    `# Terminal-Bench canary GUID ${TASK_GUID}`,
    `instruction: |-`,
    body,
    `author_email: benchmark@cheguers.invalid`,
    `difficulty: medium`,
    `category: retrieval`,
    `tags:`,
    `  - retrieval`,
    `  - knowledge-graph`,
    `  - ${stratum}`,
    `parser_name: pytest`,
    `max_agent_timeout_sec: 900.0`,
    `max_test_timeout_sec: 120.0`,
    `test_scripts:`,
    `  - run-tests.sh`,
    `run_tests_in_same_shell: false`,
    `env_name: ${id}`,
    "",
  ].join("\n");
};

const solutionFor = (gold) =>
  [
    "#!/bin/bash",
    `# terminal-bench-canary GUID ${TASK_GUID}`,
    "cat > /app/answer.json <<'JSON'",
    JSON.stringify(Object.fromEntries(gold.map((g) => [g.qid, g.gold])), null, 2),
    "JSON",
    "",
  ].join("\n");

const manifest = [];
for (const seed of seeds) {
  const gen = join(genRoot, `seed${seed}`);
  const corpus = readFileSync(join(gen, "corpus.jsonl"), "utf8");
  const edges = readFileSync(join(gen, "edges.jsonl"), "utf8");
  const publicQs = readJsonl(join(gen, "questions_public.jsonl"));
  const goldAll = readJsonl(join(gen, "gold.jsonl"));
  for (const stratum of STRATA) {
    const id = `kb-s${seed}-${stratum}`;
    const dir = join(outRoot, id);
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    const qs = publicQs.filter((q) => q.stratum === stratum);
    const gold = goldAll.filter((g) => g.stratum === stratum);

    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", "corpus.jsonl"), corpus);
    writeFileSync(join(dir, "store", "edges.jsonl"), edges);
    copyFileSync(join(gen, "vectors.jsonl"), join(dir, "store", "vectors.jsonl"));
    writeFileSync(join(dir, "data", "embed.py"), readFileSync(join(assets, "embed.py")));
    writeFileSync(join(dir, "store", "load_sqlite.py"), readFileSync(join(assets, "load_sqlite.py")));
    writeFileSync(join(dir, "store", "load_cheguers.ts"), readFileSync(join(assets, "load_cheguers.ts")));
    writeFileSync(join(dir, "data", "questions.jsonl"), qs.map((q) => JSON.stringify(q)).join("\n") + "\n");

    copyFileSync(join(assets, "Dockerfile"), join(dir, "Dockerfile"));
    copyFileSync(join(assets, "docker-compose.yaml"), join(dir, "docker-compose.yaml"));
    copyFileSync(join(assets, "run-tests.sh"), join(dir, "run-tests.sh"));
    chmodSync(join(dir, "run-tests.sh"), 0o755);
    copyFileSync(join(assets, "test_outputs.py"), join(dir, "tests", "test_outputs.py"));
    writeFileSync(join(dir, "tests", "gold.jsonl"), gold.map((g) => JSON.stringify({ qid: g.qid, gold: g.gold })).join("\n") + "\n");

    writeFileSync(join(dir, "task.yaml"), taskYaml(id, stratum, qs));
    writeFileSync(join(dir, "solution.sh"), solutionFor(gold));
    chmodSync(join(dir, "solution.sh"), 0o755);
    manifest.push({ id, seed, stratum, questions: qs.length, description: DESCRIPTIONS[stratum] });
    const filesDir = `${dir}-files`;
    cpSync(dir, filesDir, { recursive: true });
    copyFileSync(join(dir, "store", "corpus.jsonl"), join(filesDir, "data", "corpus.jsonl"));
    rmSync(join(filesDir, "store"), { recursive: true, force: true });
    copyFileSync(join(assets, "Dockerfile.files"), join(filesDir, "Dockerfile"));
    writeFileSync(join(filesDir, "task.yaml"), taskYaml(`${id}-files`, stratum, qs));
    manifest.push({ id: `${id}-files`, seed, stratum, questions: qs.length, description: DESCRIPTIONS[stratum] });

    const goldDir = `${dir}-gold`;
    mkdirSync(join(goldDir, "data"), { recursive: true });
    mkdirSync(join(goldDir, "tests"), { recursive: true });
    const support = readJsonl(join(gen, "support.jsonl")).filter((r) => r.stratum === stratum);
    writeFileSync(join(goldDir, "data", "support.jsonl"), support.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(goldDir, "data", "questions.jsonl"), qs.map((q) => JSON.stringify(q)).join("\n") + "\n");
    copyFileSync(join(assets, "Dockerfile.gold"), join(goldDir, "Dockerfile"));
    copyFileSync(join(assets, "docker-compose.yaml"), join(goldDir, "docker-compose.yaml"));
    copyFileSync(join(assets, "run-tests.sh"), join(goldDir, "run-tests.sh"));
    chmodSync(join(goldDir, "run-tests.sh"), 0o755);
    copyFileSync(join(assets, "test_outputs.py"), join(goldDir, "tests", "test_outputs.py"));
    writeFileSync(join(goldDir, "tests", "gold.jsonl"), gold.map((g) => JSON.stringify({ qid: g.qid, gold: g.gold })).join("\n") + "\n");
    writeFileSync(join(goldDir, "task.yaml"), taskYaml(`${id}-gold`, stratum, qs, GOLD_LEAD));
    writeFileSync(join(goldDir, "solution.sh"), solutionFor(gold));
    chmodSync(join(goldDir, "solution.sh"), 0o755);
    manifest.push({ id: `${id}-gold`, seed, stratum, questions: qs.length, description: DESCRIPTIONS[stratum] });

    const closedDir = `${dir}-closed`;
    mkdirSync(join(closedDir, "tests"), { recursive: true });
    copyFileSync(join(assets, "Dockerfile.closed"), join(closedDir, "Dockerfile"));
    copyFileSync(join(assets, "docker-compose.yaml"), join(closedDir, "docker-compose.yaml"));
    copyFileSync(join(assets, "run-tests.sh"), join(closedDir, "run-tests.sh"));
    chmodSync(join(closedDir, "run-tests.sh"), 0o755);
    copyFileSync(join(assets, "test_outputs.py"), join(closedDir, "tests", "test_outputs.py"));
    writeFileSync(join(closedDir, "tests", "gold.jsonl"), gold.map((g) => JSON.stringify({ qid: g.qid, gold: g.gold })).join("\n") + "\n");
    writeFileSync(join(closedDir, "task.yaml"), taskYaml(`${id}-closed`, stratum, qs, CLOSED_LEAD));
    writeFileSync(join(closedDir, "solution.sh"), solutionFor(gold));
    chmodSync(join(closedDir, "solution.sh"), 0o755);
    manifest.push({ id: `${id}-closed`, seed, stratum, questions: qs.length, description: DESCRIPTIONS[stratum] });
  }
}
writeFileSync(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${manifest.length} tasks to ${outRoot}`);
