import csv
import glob
import json
import os
import random
import sys
from collections import defaultdict
from statistics import mean

MAIN_ARMS = ["files", "sqlite3", "cheguers-full", "cheguers-vector"]
CALIBRATION_ARMS = ["closed-book", "gold-context"]
STRATA = ["hop0", "hop1", "hop2", "hop3", "filter"]
VARIANT_SUFFIXES = ("-files", "-gold", "-closed")
REPEAT_PREFIXES = {"r1": "full", "r2": "full-r2", "r3": "full-r3"}
CALIBRATION_RUNS = {"closed-book": "calib-closed-book", "gold-context": "calib-gold-context"}


def parse_scores(trial_dir):
    log = os.path.join(trial_dir, "sessions", "tests.log")
    if not os.path.exists(log):
        return None
    scores = {}
    for line in open(log, errors="replace"):
        if "SCORE " in line:
            try:
                row = json.loads(line.split("SCORE ", 1)[1].strip())
                scores[row["qid"]] = row["f1"]
            except (ValueError, KeyError):
                pass
    return scores


def budget_hit(trial_dir):
    log = os.path.join(trial_dir, "sessions", "agent.log")
    return os.path.exists(log) and "error_max_turns" in open(log, errors="replace").read()


def cheguers_calls(trial_dir):
    n = 0
    log = os.path.join(trial_dir, "sessions", "agent.log")
    if not os.path.exists(log):
        return 0
    for line in open(log, errors="replace"):
        if '"tool_use"' in line and "cheguers" in line:
            try:
                for block in json.loads(line)["message"]["content"]:
                    if block.get("type") == "tool_use" and "cheguers" in block["input"].get("command", ""):
                        n += 1
            except (ValueError, KeyError, TypeError):
                pass
    return n


def run_dirs(run_root):
    for repeat, prefix in REPEAT_PREFIXES.items():
        for arm in MAIN_ARMS:
            yield repeat, arm, os.path.join(run_root, f"{prefix}-{arm}")
    for arm, run_id in CALIBRATION_RUNS.items():
        yield "r1", arm, os.path.join(run_root, run_id)


def load(run_root):
    rows, failures, budget = [], defaultdict(int), defaultdict(int)
    for repeat, arm, run_dir in run_dirs(run_root):
        results = os.path.join(run_dir, "results.json")
        if not os.path.exists(results):
            continue
        for t in json.load(open(results))["results"]:
            task = t["task_id"]
            scenario = task
            for suffix in VARIANT_SUFFIXES:
                scenario = scenario.removesuffix(suffix)
            _, seed, stratum = scenario.split("-")
            trial = os.path.join(run_dir, task, t["trial_name"])
            hit = budget_hit(trial)
            if hit:
                budget[(arm, repeat)] += 1
            scores = parse_scores(trial)
            if not scores:
                failures[(arm, repeat, str(t["failure_mode"]))] += 1
                continue
            for qid, f1 in scores.items():
                rows.append({"arm": arm, "repeat": repeat, "seed": int(seed.removeprefix("s")),
                             "stratum": stratum, "qid": qid, "f1": f1, "budget_hit": hit,
                             "cheguers_calls": cheguers_calls(trial)})
    return rows, failures, budget


def scenario_means(rows, arm, stratum):
    """Mean F1 per scenario (seed), averaged over repeats, as the pre-registration specifies."""
    per_repeat = defaultdict(list)
    for r in rows:
        if r["arm"] == arm and r["stratum"] == stratum:
            per_repeat[(r["seed"], r["repeat"])].append(r["f1"])
    by_seed = defaultdict(list)
    for (seed, _), vals in per_repeat.items():
        by_seed[seed].append(mean(vals))
    return {seed: mean(v) for seed, v in by_seed.items()}


def bootstrap_ci(values, n=10000, seed=0):
    if not values:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    means = sorted(mean(rng.choices(values, k=len(values))) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]


def paired_perm_p(diffs, n=10000, seed=0):
    """One-sided sign-flip permutation p-value for H: mean(diff) > 0."""
    if not diffs:
        return float("nan")
    rng = random.Random(seed)
    obs = mean(diffs)
    hits = sum(mean([d if rng.random() < 0.5 else -d for d in diffs]) >= obs for _ in range(n))
    return hits / n


def holm(pvals):
    order = sorted(range(len(pvals)), key=lambda i: pvals[i])
    adjusted = [0.0] * len(pvals)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(pvals) - rank) * pvals[i]))
        adjusted[i] = running
    return adjusted


def stratum_summary(rows, arm, stratum):
    sm = scenario_means(rows, arm, stratum)
    vals = list(sm.values())
    lo, hi = bootstrap_ci(vals)
    trial_rows = [r for r in rows if r["arm"] == arm and r["stratum"] == stratum]
    exact = mean(1.0 if r["f1"] == 1.0 else 0.0 for r in trial_rows) if trial_rows else float("nan")
    calls = mean(r["cheguers_calls"] for r in trial_rows) if trial_rows else float("nan")
    return {"arm": arm, "stratum": stratum, "scenarios": len(vals),
            "mean_f1": mean(vals) if vals else float("nan"), "ci_low": lo, "ci_high": hi,
            "exact_rate": exact, "cheguers_calls_per_question": calls}


COMPARISONS = [
    ("H1", "cheguers-full", "files", ["hop2", "hop3", "filter"]),
    ("H2", "cheguers-full", "cheguers-vector", ["hop2", "hop3"]),
    ("H3", "cheguers-full", "files", ["hop0"]),
]


def tests(rows):
    out = []
    for name, a, b, strata in COMPARISONS:
        for stratum in strata:
            sa, sb = scenario_means(rows, a, stratum), scenario_means(rows, b, stratum)
            common = sorted(set(sa) & set(sb))
            diffs = [sa[s] - sb[s] for s in common]
            if diffs:
                out.append({"hypothesis": name, "comparison": f"{a} - {b}", "stratum": stratum,
                            "mean_diff": mean(diffs), "p_perm": paired_perm_p(diffs), "scenarios": len(diffs)})
    adjusted = holm([t["p_perm"] for t in out])
    for t, p in zip(out, adjusted):
        t["p_holm"] = p
    return out


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main(run_root, out_dir=None):
    rows, failures, budget = load(run_root)
    summaries = [stratum_summary(rows, arm, st) for arm in MAIN_ARMS for st in STRATA]
    calibration = [stratum_summary(rows, arm, st) for arm in CALIBRATION_ARMS for st in STRATA]
    results = tests(rows)

    print("arm               stratum  scen  mean_f1  95%CI            exact  cli/q")
    for s in summaries + calibration:
        if s["scenarios"]:
            print(f"{s['arm']:<17} {s['stratum']:<8} {s['scenarios']:<5} {s['mean_f1']:<8.3f} "
                  f"[{s['ci_low']:.3f}, {s['ci_high']:.3f}]  {s['exact_rate']:<6.3f} {s['cheguers_calls_per_question']:.1f}")
    print()
    print("hypothesis  comparison                       stratum  mean_diff  p_perm  p_holm  n")
    for t in results:
        print(f"{t['hypothesis']:<11} {t['comparison']:<30} {t['stratum']:<8} {t['mean_diff']:+.3f}    "
              f"{t['p_perm']:.4f}  {t['p_holm']:.4f}  {t['scenarios']}")
    print()
    print("turn-budget exhausted trials, by arm and repeat:")
    for (arm, repeat), n in sorted(budget.items()):
        print(f"  {arm} {repeat} x{n}")
    for (arm, repeat, kind), n in sorted(failures.items()):
        print(f"trials with no scores: {arm} {repeat} {kind} x{n}")

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        write_csv(os.path.join(out_dir, "agent-f1.csv"),
                  ["arm", "stratum", "scenarios", "mean_f1", "ci_low", "ci_high", "exact_rate", "cheguers_calls_per_question"],
                  [[s[k] if not isinstance(s[k], float) else f"{s[k]:.3f}" for k in
                    ["arm", "stratum", "scenarios", "mean_f1", "ci_low", "ci_high", "exact_rate", "cheguers_calls_per_question"]]
                   for s in summaries])
        write_csv(os.path.join(out_dir, "calibration-f1.csv"),
                  ["arm", "stratum", "scenarios", "mean_f1", "ci_low", "ci_high", "exact_rate", "cheguers_calls_per_question"],
                  [[s[k] if not isinstance(s[k], float) else f"{s[k]:.3f}" for k in
                    ["arm", "stratum", "scenarios", "mean_f1", "ci_low", "ci_high", "exact_rate", "cheguers_calls_per_question"]]
                   for s in calibration])
        write_csv(os.path.join(out_dir, "agent-tests.csv"),
                  ["hypothesis", "comparison", "stratum", "mean_diff", "p_perm", "p_holm", "scenarios"],
                  [[t["hypothesis"], t["comparison"], t["stratum"], f"{t['mean_diff']:.3f}", f"{t['p_perm']:.4f}",
                    f"{t['p_holm']:.4f}", t["scenarios"]] for t in results])
        failure_rows = []
        for arm in MAIN_ARMS + CALIBRATION_ARMS:
            for r in ["r1", "r2", "r3"]:
                if arm in CALIBRATION_ARMS and r != "r1":
                    continue
                no_scores = sum(n for (a, rep, _), n in failures.items() if a == arm and rep == r)
                failure_rows.append([arm, r, budget.get((arm, r), 0), no_scores])
        write_csv(os.path.join(out_dir, "agent-failures.csv"),
                  ["arm", "repeat", "turn_budget_exhausted_trials", "trials_without_scores"],
                  failure_rows)
        write_csv(os.path.join(out_dir, "agent-trials.csv"),
                  ["arm", "repeat", "seed", "stratum", "qid", "f1", "budget_hit", "cheguers_calls"],
                  [[r["arm"], r["repeat"], r["seed"], r["stratum"], r["qid"], f"{r['f1']:.3f}",
                    int(r["budget_hit"]), r["cheguers_calls"]] for r in rows])
    return rows


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tb-runs", sys.argv[2] if len(sys.argv) > 2 else None)
