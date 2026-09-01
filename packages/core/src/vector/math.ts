import { Buffer } from "node:buffer";
import type { SqlValue } from "../database/sql.js";
import type { VectorMetric } from "../domain/model.js";
import { isNumberValue } from "../json/runtime.js";

export const MAX_VECTOR_DIMENSIONS = 4096;
export const DEFAULT_VECTOR_NAMESPACE = "default";
export const NAMESPACE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export const isValidNamespace = (value: string): boolean => NAMESPACE_PATTERN.test(value);

export interface VectorValidation {
  readonly dimensions: number;
}

export const validateVectorInput = (vector: ReadonlyArray<number>): VectorValidation => {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new RangeError("vectors must be a non-empty array of finite numbers");
  }
  if (vector.length > MAX_VECTOR_DIMENSIONS) {
    throw new RangeError(`vectors support at most ${MAX_VECTOR_DIMENSIONS} dimensions`);
  }
  for (const value of vector) {
    if (!isNumberValue(value)) {
      throw new RangeError("vectors must contain only finite numbers");
    }
  }
  return { dimensions: vector.length };
};

/**
 * Encodes a validated vector as a little-endian float32 BLOB so storage is
 * independent of the host platform's pointer widths.
 */
export const encodeVector = (values: ReadonlyArray<number>): Uint8Array => {
  const f32 = Float32Array.from(values);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
};

export const decodeVector = (blob: SqlValue | undefined, dimensions: number): Float32Array => {
  let bytes: Uint8Array;
  if (blob instanceof Uint8Array) {
    bytes = blob;
  } else if (Buffer.isBuffer(blob)) {
    bytes = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  } else if (Array.isArray(blob)) {
    bytes = Uint8Array.from(blob);
  } else {
    bytes = new Uint8Array(0);
  }
  const f32 = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return dimensions === f32.length ? f32 : f32.subarray(0, dimensions);
};

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

/** Squared euclidean distance, computed without intermediate allocations. */
export const l2SquaredDistance = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return sum;
};

/**
 * Cosine distance in [0, 2]. A zero-magnitude operand yields similarity 0
 * (distance 1) deterministically.
 */
export const cosineDistance = (a: Float32Array, b: Float32Array): number => {
  const magnitudeA = Math.sqrt(dot(a, a));
  const magnitudeB = Math.sqrt(dot(b, b));
  if (magnitudeA === 0 || magnitudeB === 0) return 1;
  const denom = magnitudeA * magnitudeB;
  const similarity = Math.min(1, Math.max(-1, dot(a, b) / denom));
  return 1 - similarity;
};

/** L2 distance in [0, inf). */
export const l2Distance = (a: Float32Array, b: Float32Array): number =>
  Math.sqrt(l2SquaredDistance(a, b));

export const distanceBetween = (metric: VectorMetric, a: Float32Array, b: Float32Array): number =>
  metric === "cosine" ? cosineDistance(a, b) : l2Distance(a, b);

/**
 * Maps a distance to a normalized similarity score in [0, 1] used by hybrid
 * reranking. Purely deterministic per metric.
 */
export const similarityScore = (metric: VectorMetric, distance: number): number =>
  metric === "cosine" ? Math.max(0, 1 - distance / 2) : 1 / (1 + Math.max(0, distance));
