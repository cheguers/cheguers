import type { Effect } from "effect";
import type { EmbeddingError } from "../errors.js";

/**
 * Text → dense vector provider. Every vector an embedder returns has exactly
 * `dimensions` components, so one embedder maps to one vector namespace.
 */
export interface Embedder {
  /** Stable identifier recorded in telemetry, e.g. `hash-384`. */
  readonly id: string;
  readonly dimensions: number;
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError>;
}

/** Scales a vector to unit length; zero vectors are returned unchanged. */
export const normalizeVector = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
  let norm = 0;
  for (const value of values) norm += value * value;
  if (norm === 0) return values;
  const scale = 1 / Math.sqrt(norm);
  return values.map((value) => value * scale);
};
