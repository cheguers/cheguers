import csv
from pathlib import Path

DATA = Path(__file__).parent / "data"


def esc(text):
    if "$" in text:
        return text
    return (text.replace("\\", r"\textbackslash{}").replace("&", r"\&").replace("%", r"\%")
            .replace("$", r"\$").replace("#", r"\#").replace("_", r"\_").replace("{", r"\{").replace("}", r"\}")
            .replace("~", r"\textasciitilde{}").replace("^", r"\textasciicircum{}"))


def rows(name):
    with open(DATA / f"{name}.csv", newline="") as f:
        return list(csv.reader(f))


def tabular(spec, header, body, extra_head=None):
    lines = [f"\\begin{{tabular}}{{{spec}}}", "\\toprule"]
    if extra_head:
        lines.append(extra_head)
    lines.append(" & ".join(header) + " \\\\")
    lines.append("\\midrule")
    lines += [" & ".join(esc(c) for c in row) + " \\\\" for row in body]
    lines += ["\\bottomrule", "\\end{tabular}", ""]
    return "\n".join(lines)


def latency():
    r = rows("latency-d128")
    head = ["Scenario", "p50", "p95", "p50", "p95", "p99"]
    extra = r"\multicolumn{1}{l}{} & \multicolumn{2}{c}{$N=\num{2500}$} & \multicolumn{3}{c}{$N=\num{10000}$} \\ \cmidrule(lr){2-3}\cmidrule(lr){4-6}"
    return tabular("l" + "r" * 5, head, r[1:], extra)


def ingestion():
    r = rows("ingestion")
    head = ["Metric", "$N{=}\\num{2500}$, $d{=}128$", "$N{=}\\num{10000}$, $d{=}128$", "$N{=}\\num{10000}$, $d{=}384$"]
    return tabular("lrrr", head, r[1:])


def gate():
    r = rows("gate")
    head = ["Seed", "Stratum", "Queries", "Vector recall@20", "Hybrid recall@20"]
    return tabular("rlrrr", head, r[1:])


def agent_f1():
    r = rows("agent-f1")
    head = ["Arm", "Stratum", "Scen.", "Mean F1", "CI low", "CI high", "Exact", "CLI/q"]
    body = [[row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]] for row in r[1:]]
    return tabular("llrrrrrr", head, body)


def calibration():
    r = rows("calibration-f1")
    head = ["Arm", "Stratum", "Scen.", "Mean F1", "CI low", "CI high", "Exact"]
    body = [[row[0], row[1], row[2], row[3], row[4], row[5], row[6]] for row in r[1:]]
    return tabular("llrrrrr", head, body)


def agent_tests():
    r = rows("agent-tests")
    head = ["Hyp.", "Comparison", "Stratum", "Mean diff", "$p$", "$p_{\\mathrm{Holm}}$", "n"]
    body = [[row[0], row[1], row[2], row[3], row[4], row[5], row[6]] for row in r[1:]]
    return tabular("lllrrrr", head, body)


def agent_failures():
    r = rows("agent-failures")
    head = ["Arm", "Repeat", "Turn budget exhausted", "No scores"]
    return tabular("llrr", head, r[1:])


STRATA = ["hop0", "hop1", "hop2", "hop3", "filter"]


def agent_f1_wide():
    """Mean F1 with bootstrap CI, one row per arm, one column per stratum (main and calibration arms)."""
    def block(name):
        cells = {}
        order = []
        for row in rows(name)[1:]:
            arm, stratum, mean, lo, hi = row[0], row[1], float(row[3]), float(row[4]), float(row[5])
            if arm not in order:
                order.append(arm)
            cells[(arm, stratum)] = f"{mean:.2f} {{\\scriptsize[{lo:.2f}, {hi:.2f}]}}"
        return [[esc(arm)] + [cells[(arm, s)] for s in STRATA] for arm in order]

    main, calib = block("agent-f1"), block("calibration-f1")
    lines = ["\\begin{tabular}{l" + "c" * len(STRATA) + "}", "\\toprule",
             "Arm & " + " & ".join(STRATA) + " \\\\", "\\midrule"]
    lines += [" & ".join(r) + " \\\\" for r in main]
    lines.append("\\midrule")
    lines += [" & ".join(r) + " \\\\" for r in calib]
    lines += ["\\bottomrule", "\\end{tabular}", ""]
    return "\n".join(lines)


TABLES = {
    "latency-d128": latency, "ingestion": ingestion, "gate": gate,
    "agent-f1": agent_f1, "agent-f1-wide": agent_f1_wide, "calibration-f1": calibration, "agent-tests": agent_tests, "agent-failures": agent_failures,
}

if __name__ == "__main__":
    for name, build in TABLES.items():
        (DATA / f"{name}.tex").write_text(build())
        print(f"wrote data/{name}.tex")
