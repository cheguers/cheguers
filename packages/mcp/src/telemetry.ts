import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { JsonObject, JsonValue } from "@cheguers/core";
import type { BackendStats } from "./backend/types.js";

/** One line per tool call in the JSONL telemetry file. */
export interface ToolCallEvent {
  readonly tool: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Items returned or written (hits, chunks, neighbors…). */
  readonly results: number;
  readonly error: string | undefined;
  /** Storage snapshot taken after write tools. */
  readonly stats: BackendStats | undefined;
}

export interface ToolSummary {
  readonly calls: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly results: number;
}

export interface TelemetrySummary {
  readonly runId: string;
  readonly uptimeMs: number;
  readonly tools: Readonly<Record<string, ToolSummary>>;
}

export interface Telemetry {
  readonly runId: string;
  /** Absolute path of the JSONL file, or undefined when telemetry is disabled. */
  readonly file: string | undefined;
  readonly start: (fields: JsonObject) => Effect.Effect<void>;
  readonly record: (event: ToolCallEvent) => Effect.Effect<void>;
  readonly summary: Effect.Effect<TelemetrySummary>;
  /** Writes the summary line (with the final storage stats) and stops recording. */
  readonly finish: (stats: BackendStats | undefined) => Effect.Effect<void>;
}

const percentile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

const round = (value: number): number => Math.round(value * 1000) / 1000;

const statsJson = (stats: BackendStats): JsonObject => ({
  backend: stats.backend,
  embedder: stats.embedder ?? null,
  notes: stats.notes,
  documents: stats.documents,
  chunks: stats.chunks,
  links: stats.links,
  vectors: stats.vectors,
  storageBytes: stats.storageBytes,
});

const summaryJson = (summary: TelemetrySummary): JsonObject => {
  const tools: Record<string, JsonValue> = {};
  for (const [name, tool] of Object.entries(summary.tools)) {
    tools[name] = { ...tool };
  }
  return { runId: summary.runId, uptimeMs: summary.uptimeMs, tools };
};

/**
 * JSONL telemetry sink. Writes are synchronous appends so lines survive an
 * abrupt container stop; one file per server run (`<dir>/<runId>.jsonl`).
 */
export const makeTelemetry = (dir: string | undefined, runId: string): Telemetry => {
  const startedAt = performance.now();
  const latencies = new Map<string, Array<number>>();
  const errors = new Map<string, number>();
  const results = new Map<string, number>();
  let finished = false;
  let file: string | undefined;
  if (dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${runId}.jsonl`);
  }

  const write = (line: JsonObject): void => {
    if (file === undefined || finished) return;
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), runId, ...line })}\n`);
  };

  const summarize = (): TelemetrySummary => {
    const tools: Record<string, ToolSummary> = {};
    for (const [tool, values] of latencies) {
      const sorted = [...values].sort((a, b) => a - b);
      tools[tool] = {
        calls: values.length,
        errors: errors.get(tool) ?? 0,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted[sorted.length - 1] ?? 0),
        results: results.get(tool) ?? 0,
      };
    }
    return { runId, uptimeMs: Math.round(performance.now() - startedAt), tools };
  };

  return {
    runId,
    file,
    start: (fields) => Effect.sync(() => write({ type: "start", ...fields })),
    record: (event) =>
      Effect.sync(() => {
        const bucket = latencies.get(event.tool) ?? [];
        bucket.push(event.latencyMs);
        latencies.set(event.tool, bucket);
        if (!event.ok) errors.set(event.tool, (errors.get(event.tool) ?? 0) + 1);
        results.set(event.tool, (results.get(event.tool) ?? 0) + event.results);
        const line: Record<string, JsonValue> = {
          type: "call",
          tool: event.tool,
          ok: event.ok,
          latencyMs: round(event.latencyMs),
          results: event.results,
        };
        if (event.error !== undefined) line.error = event.error;
        if (event.stats !== undefined) line.stats = statsJson(event.stats);
        write(line);
      }),
    summary: Effect.sync(summarize),
    finish: (stats) =>
      Effect.sync(() => {
        const line: Record<string, JsonValue> = { type: "summary", ...summaryJson(summarize()) };
        if (stats !== undefined) line.stats = statsJson(stats);
        write(line);
        finished = true;
      }),
  };
};
