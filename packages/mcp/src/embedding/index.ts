import type { Embedder } from "./embedder.js";
import { makeHashEmbedder } from "./hash.js";
import { makeOpenAiEmbedder } from "./openai.js";
import { makeTransformersEmbedder } from "./transformers.js";

export type { Embedder } from "./embedder.js";
export { normalizeVector } from "./embedder.js";
export { DEFAULT_HASH_DIMENSIONS, hashEmbedText, makeHashEmbedder, tokenize } from "./hash.js";
export { makeOpenAiEmbedder, type OpenAiEmbedderConfig } from "./openai.js";
export { makeTransformersEmbedder, type TransformersEmbedderConfig } from "./transformers.js";

export type EmbedderProvider = "transformers" | "openai" | "hash";

export interface EmbedderSettings {
  readonly provider: EmbedderProvider;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  readonly cacheDir: string | undefined;
  readonly offline: boolean;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

export const makeEmbedder = (settings: EmbedderSettings): Embedder => {
  switch (settings.provider) {
    case "hash":
      return makeHashEmbedder(settings.dimensions);
    case "openai":
      return makeOpenAiEmbedder({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        dimensions: settings.dimensions,
        batchSize: settings.batchSize,
      });
    case "transformers":
      return makeTransformersEmbedder({
        model: settings.model,
        dimensions: settings.dimensions,
        batchSize: settings.batchSize,
        cacheDir: settings.cacheDir,
        offline: settings.offline,
      });
  }
};
