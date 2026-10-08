#!/usr/bin/env python3
"""Aggregate Harbor job results for the CheguersDB x Terminal-Bench experiment.

usage: python3 bench/harbor/analyze.py [JOBS_DIR] [--out DIR]

The arm of each job is taken from its name prefix (run.sh names jobs
"<arm>-<UTC timestamp>"). Writes trials.csv and summary.md to --out
(default: JOBS_DIR/..) and prints the summary. Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import statistics
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

ARMS = ("baseline", "cheguers", "vector-only", "notes")
JOB_SUFFIX = re.compile(r"-\d{8}T\d{6}Z$")


@dataclass
class Trial:
    arm: str
    job: str
    task: str
    trial: str
    reward: float | None
    passed: bool
    error: str
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    agent_seconds: float | None
    memory_calls: int = 0
    memory_errors: int = 0
    memory_tools: dict[str, int] = field(default_factory=dict)
    memory_p95_ms: float | None = None
    memory_items: int | None = None
    memory_bytes: int | None = None


def arm_of(job_name: str) -> str:
    base = JOB_SUFFIX.sub("", job_name)
    return base if base in ARMS else base or "unknown"


def seconds(timing: dict | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    start = datetime.fromisoformat(timing["started_at"])
    end = datetime.fromisoformat(timing["finished_at"])
    return (end - start).total_seconds()


def reward_of(result: dict) -> float | None:
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    if not rewards:
        return None
    value = rewards.get("reward", next(iter(rewards.values())))
    return float(value)


def read_telemetry(trial_dir: Path, trial: Trial) -> None:
    for path in sorted((trial_dir / "agent").glob("*.jsonl")):
        lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if not lines or lines[0].get("type") != "start" or "backend" not in lines[0]:
            continue
        latencies = []
        for line in lines:
            if line.get("type") == "call":
                trial.memory_calls += 1
                trial.memory_errors += 0 if line.get("ok") else 1
                tool = line.get("tool", "?")
                trial.memory_tools[tool] = trial.memory_tools.get(tool, 0) + 1
                latencies.append(float(line.get("latencyMs", 0)))
            if line.get("stats"):
                stats = line["stats"]
                trial.memory_items = stats.get("notes", 0) + stats.get("chunks", 0)
                trial.memory_bytes = stats.get("storageBytes")
        if latencies:
            latencies.sort()
            trial.memory_p95_ms = latencies[min(len(latencies) - 1, int(0.95 * len(latencies)))]


def load_trials(jobs_dir: Path) -> list[Trial]:
    trials: list[Trial] = []
    for job_dir in sorted(p for p in jobs_dir.iterdir() if p.is_dir()):
        arm = arm_of(job_dir.name)
        for result_path in sorted(job_dir.glob("*/result.json")):
            result = json.loads(result_path.read_text())
            agent = result.get("agent_result") or {}
            exception = result.get("exception_info") or {}
            reward = reward_of(result)
            trial = Trial(
                arm=arm,
                job=job_dir.name,
                task=result.get("task_name", result_path.parent.name).split("/")[-1],
                trial=result.get("trial_name", result_path.parent.name),
                reward=reward,
                passed=reward is not None and reward >= 1.0,
                error=exception.get("exception_type", ""),
                input_tokens=agent.get("n_input_tokens"),
                output_tokens=agent.get("n_output_tokens"),
                cost_usd=agent.get("cost_usd"),
                agent_seconds=seconds(result.get("agent_execution")),
            )
            read_telemetry(result_path.parent, trial)
            trials.append(trial)
    return trials


def mean(values: list[float | int | None]) -> float | None:
    present = [float(v) for v in values if v is not None]
    return statistics.fmean(present) if present else None


def bootstrap_ci(per_task: dict[str, list[bool]], rounds: int = 2000) -> tuple[float, float]:
    """95% CI of the task-averaged pass rate, resampling tasks."""
    tasks = list(per_task)
    if not tasks:
        return (0.0, 0.0)
    rng = random.Random(7)
    rates = []
    for _ in range(rounds):
        sample = [rng.choice(tasks) for _ in tasks]
        rates.append(statistics.fmean(statistics.fmean(per_task[t]) for t in sample))
    rates.sort()
    return rates[int(0.025 * rounds)], rates[int(0.975 * rounds) - 1]


def fmt(value: float | None, digits: int = 2, suffix: str = "") -> str:
    return "-" if value is None else f"{value:.{digits}f}{suffix}"


def summarize(trials: list[Trial]) -> str:
    by_arm: dict[str, list[Trial]] = defaultdict(list)
    for trial in trials:
        by_arm[trial.arm].append(trial)
    arms = [a for a in ARMS if a in by_arm] + sorted(a for a in by_arm if a not in ARMS)

    out = ["## Per arm", ""]
    out.append(
        "| arm | trials | pass rate (task-avg) | 95% CI | exceptions | mean cost $ "
        "| mean in tok | mean out tok | mean agent min | used memory | memory calls/trial |"
    )
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for arm in arms:
        group = by_arm[arm]
        per_task: dict[str, list[bool]] = defaultdict(list)
        for t in group:
            per_task[t.task].append(t.passed)
        rate = statistics.fmean(statistics.fmean(v) for v in per_task.values())
        low, high = bootstrap_ci(per_task)
        used = sum(1 for t in group if t.memory_calls > 0)
        out.append(
            f"| {arm} | {len(group)} | {rate:.1%} | {low:.1%}–{high:.1%} "
            f"| {sum(1 for t in group if t.error)} | {fmt(mean([t.cost_usd for t in group]))} "
            f"| {fmt(mean([t.input_tokens for t in group]), 0)} "
            f"| {fmt(mean([t.output_tokens for t in group]), 0)} "
            f"| {fmt(mean([None if t.agent_seconds is None else t.agent_seconds / 60 for t in group]), 1)} "
            f"| {used}/{len(group)} | {fmt(mean([t.memory_calls for t in group]), 1)} |"
        )

    tasks = sorted({t.task for t in trials})
    out += ["", "## Pass rate per task", ""]
    out.append("| task | " + " | ".join(arms) + " |")
    out.append("|---|" + "---|" * len(arms))
    for task in tasks:
        cells = []
        for arm in arms:
            group = [t for t in by_arm[arm] if t.task == task]
            cells.append(
                "-" if not group else f"{sum(t.passed for t in group)}/{len(group)}"
            )
        out.append(f"| {task} | " + " | ".join(cells) + " |")

    memory_trials = [t for t in trials if t.memory_calls > 0]
    if memory_trials:
        out += ["", "## Memory tool usage", ""]
        out.append("| arm | tool | calls | trials using it |")
        out.append("|---|---|---|---|")
        for arm in arms:
            totals: dict[str, int] = defaultdict(int)
            users: dict[str, int] = defaultdict(int)
            for t in by_arm[arm]:
                for tool, count in t.memory_tools.items():
                    totals[tool] += count
                    users[tool] += 1
            for tool in sorted(totals):
                out.append(f"| {arm} | {tool} | {totals[tool]} | {users[tool]} |")
        p95 = [t.memory_p95_ms for t in memory_trials if t.memory_p95_ms is not None]
        if p95:
            out += ["", f"Median per-trial p95 memory latency: {statistics.median(p95):.1f} ms"]
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("jobs_dir", nargs="?", default=str(Path(__file__).parent / "../results/jobs"))
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    jobs_dir = Path(args.jobs_dir).resolve()
    out_dir = Path(args.out).resolve() if args.out else jobs_dir.parent
    trials = load_trials(jobs_dir)
    if not trials:
        raise SystemExit(f"no trial results under {jobs_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "trials.csv").open("w", newline="") as handle:
        rows = [asdict(t) | {"memory_tools": json.dumps(t.memory_tools)} for t in trials]
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    summary = summarize(trials)
    (out_dir / "summary.md").write_text(summary + "\n")
    print(summary)


if __name__ == "__main__":
    main()
