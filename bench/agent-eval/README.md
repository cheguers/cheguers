# Agent evaluation: does a hybrid graph-vector store help an agent answer relational questions?

This directory holds the pre-registered study reported in `docs/paper/cheguersdb-softwarex.tex`.
The pre-registration is `spec/PREREG.md`; its last section lists every deviation from the draft.

## Layout

- `gen/generate.mjs`: seeded synthetic corpus and questions. Writes `corpus.jsonl`, `edges.jsonl`,
  `questions_public.jsonl` (the agent sees these), `gold.jsonl` and `support.jsonl` (hidden from the agent,
  used only at scoring and for the gold-context arm), and `manifest.json` (SHA-256 hashes).
- `tasks/precompute_vectors.py`: writes all-MiniLM-L6-v2 vectors for the corpus and questions.
- `tasks/build-tasks.mjs`: builds Terminal-Bench tasks: `kb-s<seed>-<stratum>` (main arms),
  `-files` (files arm, no edge store), `-closed` (closed-book calibration), `-gold` (gold-context calibration).
- `tasks/base/Dockerfile`: base image `kb-base:minilm` with the embedder and model.
- `tasks/assets/`: test and loader files copied into each task (`test_outputs.py`, `load_cheguers.ts`, ...).
- `agents/arms_agent.py`: one agent class per arm. Each arm sets its hint and install step.
- `retrieval-eval/gate.mjs`: offline top-k retrieval gate (no LLM).
- `analysis/score.py`: scores the runs, computes the pre-registered tests, and exports the CSVs used in the paper.
- `run/run-study.sh`: runs the calibration arms and three repeats of the four main arms.

## Reproduce

Requirements: Node.js 24, pnpm, Python 3.13, Docker, `terminal-bench==0.1.1`, and a Claude subscription
token in `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).

```sh
# 1. Embedder and base image (downloads the model once).
python3 -m venv .venv && .venv/bin/pip install fastembed
.venv/bin/python tasks/precompute_vectors.py <cache-dir> <gen-dir>/seed1 ... <gen-dir>/seed6
docker build -t kb-base:minilm tasks/base

# 2. Corpora and tasks, seeds 1 to 6, five questions per stratum.
for s in 1 2 3 4 5 6; do node gen/generate.mjs <gen-dir>/seed$s $s 5; done
node tasks/build-tasks.mjs <gen-dir> <tasks-dir>

# 3. Run the study (about 300 trials; see the paper for runtime).
CLAUDE_CODE_OAUTH_TOKEN=... sh run/run-study.sh <work-dir> <tasks-dir>

# 4. Score and export the paper's tables.
python3 analysis/score.py <work-dir>/tb-runs <paper-data-dir>
```

`precompute_vectors.py` expects `fastembed` and writes `vectors.jsonl` and `question_vectors.jsonl`
into each seed directory; `build-tasks.mjs` copies them into the task stores.

## Notes

- Gold answers and `support.jsonl` are copied into a task only at scoring time (`tests/`) or for the
  gold-context arm. The main arms never see them.
- The files arm uses the `-files` task variant, which has no edge store.
- The 12-turn budget is set by `ARM_MAX_TURNS` (default 12) and passed to `claude --max-turns`.
- The database arms load their data at install time through `load_cheguers.ts` or `load_sqlite.py`, then
  delete the edge store.
