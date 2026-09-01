/**
 * CheguersDB benchmark harness report shape.
 *
 * Benchmarks exist to decide optimizations, not as a research deliverable.
 * Every run records environment info, dataset seed/size, warmup, and
 * repetition count alongside the measurements.
 */

export interface BenchmarkEnvironment {
  readonly nodeVersion: string
  readonly platform: string
  readonly datasetSeed: number
  readonly recordCount: number
  readonly measuredFanout: number
  readonly vectorDimensions: number
  readonly secondaryVectorDimensions: number
  readonly warmupRuns: number
  readonly measuredRuns: number
  /** Database file size on disk after ingestion. */
  readonly dbSizeBytes: number
  /** Resident set size of the benchmark process. */
  readonly rssBytes: number
}

export interface ScenarioResult {
  readonly name: string
  readonly unit: "ms" | "ops/s"
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

export interface BenchmarkReport {
  readonly environment: BenchmarkEnvironment
  readonly scenarios: ReadonlyArray<ScenarioResult>
}
