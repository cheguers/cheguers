# Terminal-Bench × CheguersDB

Harness for measuring whether giving a coding agent CheguersDB as task memory
changes its Terminal-Bench results.

Terminal-Bench evaluates **agents**, not databases. CheguersDB enters as a tool:
an MCP server (`packages/mcp`) that runs as a sidecar container next to every
trial and exposes the same memory tools in every arm.

| Arm           | What the agent gets                                                        | Answers                                      |
| ------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| `baseline`    | nothing extra                                                              | reference                                    |
| `cheguers`    | memory tools on CheguersDB, hybrid search (vector seeds + graph expansion) | does CheguersDB help?                        |
| `vector-only` | same tools, CheguersDB vector search only                                  | does the graph matter?                       |
| `notes`       | same tools, in-memory notes with BM25 keyword search                       | is it CheguersDB or just "having a notepad"? |

Tool names, parameters and descriptions are identical across the memory arms
and the backend is never revealed to the agent.

## Layout

```
bench/harbor/
├── run.sh                       # run one arm with harbor
├── analyze.py                   # aggregate jobs → summary.md + trials.csv
├── compose/cheguers-sidecar.yaml# overlay: adds the `cheguers` service to each trial
├── mcp/cheguers.mcp.json        # MCP config (http://cheguers:8765/mcp)
├── mcp/cheguers-localhost.mcp.json  # for tasks whose network is routed through Harbor's egress sidecar
├── instructions/memory.md       # appended to the task instruction in memory arms
└── tasks/pilot.txt              # pilot task subset
```

## Prerequisites

- Docker (Linux, or Docker Desktop + WSL2 on Windows — run everything from WSL).
- Python ≥ 3.12 and [uv](https://docs.astral.sh/uv/): `uv tool install "harbor[modal,daytona]"`.
- Node 22 + pnpm 10 for this repo: `pnpm install` (updates `pnpm-lock.yaml` the
  first time after adding `packages/mcp`; commit the lockfile).
- A local clone of Terminal-Bench: `git clone https://github.com/harbor-framework/terminal-bench`.
- Model credentials: `ANTHROPIC_API_KEY` (recommended for real runs).

## 1. Build the sidecar image

```sh
docker build -f packages/mcp/Dockerfile -t cheguers-mcp:latest .
```

The build downloads the embedding model (`Xenova/all-MiniLM-L6-v2`, 384 dims)
into the image, so trials run with `CHEGUERS_EMBED_OFFLINE=true`.

## 2. Validate the environment (oracle)

```sh
harbor run -p "$TB_TASKS_DIR" -i ontology-kg-querying --agent oracle --env docker -k 5
```

All oracle trials must pass before any agent run means anything.

## 3. Smoke test (one task, memory arm)

```sh
export TB_TASKS_DIR=~/terminal-bench/tasks MODEL=anthropic/claude-sonnet-4-5
ATTEMPTS=1 CONCURRENCY=1 TASKS_FILE=<(echo ontology-kg-querying) bench/harbor/run.sh cheguers
```

Check `bench/results/jobs/<job>/<trial>/agent/*.jsonl`: a `start` line, `call`
lines for each memory tool the agent used, and a final `summary` line.

With a Claude subscription instead of an API key (smoke tests only; usage
limits will cut long runs short and bias comparisons):

```sh
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=...
bench/harbor/run.sh cheguers --ae CLAUDE_FORCE_OAUTH=1
```

## 4. Pilot and full runs

```sh
ATTEMPTS=2 bench/harbor/run.sh baseline
ATTEMPTS=2 bench/harbor/run.sh cheguers
ATTEMPTS=2 bench/harbor/run.sh notes
ATTEMPTS=2 bench/harbor/run.sh vector-only   # optional ablation
python3 bench/harbor/analyze.py bench/results/jobs
```

Keep model, agent version, attempts, concurrency and hardware identical across
arms. Job names must start with the arm (`run.sh` does this) for `analyze.py`.

## Networking caveat

The overlay assumes the default compose network (task `network_mode = public`),
where the agent reaches the sidecar as `http://cheguers:8765/mcp`. For tasks
whose network is restricted, Harbor routes services through its egress sidecar's
network namespace; use `MCP_CONFIG=bench/harbor/mcp/cheguers-localhost.mcp.json`
for those runs.

## What is measured

- Per trial (from Harbor): reward, exceptions, tokens, cost, agent wall time.
- Per trial (from the sidecar telemetry): calls per tool, errors, latency
  p50/p95, items and bytes stored.
- Storage alone: `pnpm bench:memory` (ingest throughput and search latency at
  20k chunks) and `pnpm bench:realistic` (core benchmark at 10k records, 384 dims).
