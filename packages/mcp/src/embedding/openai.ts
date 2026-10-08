import { Effect } from "effect";
import { isJsonArray, isNumberValue, parseJsonObject } from "@cheguers/core";
import { EmbeddingError } from "../errors.js";
import type { Embedder } from "./embedder.js";

export interface OpenAiEmbedderConfig {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
}

const parseEmbeddingRows = (
  body: string,
  expected: number,
  dimensions: number,
): ReadonlyArray<ReadonlyArray<number>> => {
  const root = parseJsonObject(JSON.parse(body), "embeddings response must be a JSON object");
  const data = root.data;
  if (data === undefined || !isJsonArray(data) || data.length !== expected) {
    throw new EmbeddingError({ message: `embeddings response must carry ${expected} rows` });
  }
  const rows = new Array<ReadonlyArray<number>>(expected);
  for (const entry of data) {
    const row = parseJsonObject(entry, "embedding row must be an object");
    const index = row.index;
    const embedding = row.embedding;
    if (!isNumberValue(index) || index < 0 || index >= expected) {
      throw new EmbeddingError({ message: "embedding row carries an invalid index" });
    }
    if (embedding === undefined || !isJsonArray(embedding) || embedding.length !== dimensions) {
      throw new EmbeddingError({
        message: `embedding row ${index} must have ${dimensions} dimensions`,
      });
    }
    const values: Array<number> = [];
    for (const value of embedding) {
      if (!isNumberValue(value)) {
        throw new EmbeddingError({ message: `embedding row ${index} has a non-numeric value` });
      }
      values.push(value);
    }
    rows[index] = values;
  }
  return rows;
};

const toEmbeddingError = (cause: Error): EmbeddingError =>
  cause instanceof EmbeddingError ? cause : new EmbeddingError({ message: cause.message });

/**
 * OpenAI-compatible `/embeddings` client. Works with OpenAI itself and with
 * self-hosted servers exposing the same contract (TEI, vLLM, Ollama).
 */
export const makeOpenAiEmbedder = (config: OpenAiEmbedderConfig): Embedder => {
  const requestBatch = (batch: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: config.model, input: batch }),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new EmbeddingError({
            message: `embeddings request failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
          });
        }
        return parseEmbeddingRows(body, batch.length, config.dimensions);
      },
      catch: (cause) =>
        cause instanceof Error
          ? toEmbeddingError(cause)
          : new EmbeddingError({ message: "embeddings request failed" }),
    });

  return {
    id: `openai:${config.model}`,
    dimensions: config.dimensions,
    embed: (texts) =>
      Effect.gen(function* () {
        const out: Array<ReadonlyArray<number>> = [];
        for (let start = 0; start < texts.length; start += config.batchSize) {
          out.push(...(yield* requestBatch(texts.slice(start, start + config.batchSize))));
        }
        return out;
      }),
  };
};
