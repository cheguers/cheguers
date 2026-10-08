import { Effect } from "effect";
import { normalizeVector, type Embedder } from "./embedder.js";

export const DEFAULT_HASH_DIMENSIONS = 384;

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

/** 32-bit FNV-1a over UTF-16 code units. */
const fnv1a = (text: string, seed: number): number => {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const tokenize = (text: string): ReadonlyArray<string> =>
  text.toLowerCase().match(TOKEN_PATTERN) ?? [];

const addFeature = (vector: Array<number>, feature: string, weight: number): void => {
  const bucket = fnv1a(feature, 0) % vector.length;
  const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
  vector[bucket] = vector[bucket]! + sign * weight;
};

/**
 * Deterministic feature-hashing embedder over word unigrams, word bigrams and
 * character trigrams. It is lexical, not semantic: use it for tests and as a
 * no-download fallback, never as the embedder of a reported benchmark arm.
 */
export const hashEmbedText = (text: string, dimensions: number): ReadonlyArray<number> => {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    addFeature(vector, `w:${token}`, 1);
    const next = tokens[i + 1];
    if (next !== undefined) addFeature(vector, `b:${token} ${next}`, 0.5);
    const padded = `^${token}$`;
    for (let j = 0; j + 3 <= padded.length; j++) {
      addFeature(vector, `c:${padded.slice(j, j + 3)}`, 0.25);
    }
  }
  return normalizeVector(vector);
};

export const makeHashEmbedder = (dimensions: number = DEFAULT_HASH_DIMENSIONS): Embedder => ({
  id: `hash-${dimensions}`,
  dimensions,
  embed: (texts) => Effect.sync(() => texts.map((text) => hashEmbedText(text, dimensions))),
});
