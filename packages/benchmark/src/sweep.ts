import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchmarkReport } from "./report.js";

/**
 * Runs `run.ts` repeatedly over a matrix of (records, dimensions) configs,
 * each repetition in a fresh process, and writes the raw reports plus a
 * markdown summary (median and min–max across repetitions).
 *
 * Usage: sweep.ts [repeats] [configs] [measuredRuns] [outDir]
 *   configs: comma-separated `records:dims`, e.g. `2500:128,10000:128`
 */

interface SweepConfig {
  readonly records: number;
  readonly dims: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const runScript = join(here, "run.ts");

const repeats = Number(process.argv[2] ?? 5);
const configs: ReadonlyArray<SweepConfig> = (process.argv[3] ?? "2500:128,10000:128,10000:384")
  .split(",")
  .map((pair) => {
    const [records, dims] = pair.split(":").map(Number);
    return { records: records!, dims: dims! };
  });
const measuredRuns = Number(process.argv[4] ?? 50);
const outDir = resolve(
  process.argv[5] ?? join("bench-results", new Date().toISOString().replace(/[:.]/g, "-")),
);

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const fmt = (value: number): string =>
  value >= 1000 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

const range = (values: ReadonlyArray<number>): string =>
  `${fmt(Math.min(...values))}–${fmt(Math.max(...values))}`;

const gitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const runOnce = (config: SweepConfig): BenchmarkReport => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      runScript,
      String(config.records),
      String(measuredRuns),
      String(config.dims),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`run.ts failed for ${config.records}:${config.dims}\n${result.stderr}`);
  }
  // SAFETY: run.ts prints exactly one BenchmarkReport as JSON on stdout.
  return JSON.parse(result.stdout) as BenchmarkReport;
};

const summarize = (config: SweepConfig, reports: ReadonlyArray<BenchmarkReport>): string => {
  const lines = [
    `## ${config.records} records, d=${config.dims}`,
    "",
    "| scenario | unit | p50 (median) | p95 (median) | p95 (min–max) | p99 (median) |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const scenario of reports[0]!.scenarios) {
    const samples = reports.map((report) =>
      report.scenarios.find((s) => s.name === scenario.name)!,
    );
    const p95s = samples.map((s) => s.p95);
    lines.push(
      `| ${scenario.name} | ${scenario.unit} | ${fmt(median(samples.map((s) => s.p50)))} | ${fmt(median(p95s))} | ${range(p95s)} | ${fmt(median(samples.map((s) => s.p99)))} |`,
    );
  }
  const dbMiB = reports.map((r) => r.environment.dbSizeBytes / 1024 / 1024);
  const rssMiB = reports.map((r) => r.environment.rssBytes / 1024 / 1024);
  lines.push(
    "",
    `DB size (MiB): median ${fmt(median(dbMiB))}, range ${range(dbMiB)}. ` +
      `Process RSS (MiB): median ${fmt(median(rssMiB))}, range ${range(rssMiB)}.`,
    "",
  );
  return lines.join("\n");
};

mkdirSync(outDir, { recursive: true });

const sections: Array<string> = [];
for (const config of configs) {
  const reports: Array<BenchmarkReport> = [];
  for (let i = 0; i < repeats; i++) {
    console.error(`[sweep] ${config.records}:${config.dims} run ${i + 1}/${repeats}`);
    const report = runOnce(config);
    writeFileSync(
      join(outDir, `${config.records}-${config.dims}-${i + 1}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    reports.push(report);
  }
  sections.push(summarize(config, reports));
}

const header = [
  "# CheguersDB benchmark sweep",
  "",
  `- commit: ${gitCommit()}`,
  `- cpu: ${cpus()[0]?.model ?? "unknown"} (${cpus().length} cores), memory: ${fmt(totalmem() / 1024 ** 3)} GiB`,
  `- node: ${process.version} (${process.platform}-${process.arch})`,
  `- repetitions per config: ${repeats} (fresh process each), measured runs per scenario: ${measuredRuns}`,
  "",
  "Percentiles are computed within each run; the table reports the median across",
  "repetitions and the min–max of p95 to show run-to-run variance.",
  "",
].join("\n");

writeFileSync(join(outDir, "summary.md"), `${header}\n${sections.join("\n")}`);
console.error(`[sweep] wrote ${outDir}/summary.md`);
