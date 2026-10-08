import { Effect } from "effect";
import { EmbeddingError } from "../errors.js";
import type { Embedder } from "./embedder.js";

export interface TransformersEmbedderConfig {
  /** Hugging Face model id, e.g. `Xenova/all-MiniLM-L6-v2`. */
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  /** Directory holding pre-downloaded model files (baked into the image). */
  readonly cacheDir: string | undefined;
  /** When true the model must already be in `cacheDir`; no network access. */
  readonly offline: boolean;
}

interface FeatureTensor {
  readonly tolist: () => Array<Array<number>>;
}

interface PoolingOptions {
  readonly pooling: "mean";
  readonly normalize: boolean;
}

type FeatureExtractor = (texts: Array<string>, options: PoolingOptions) => Promise<FeatureTensor>;

interface TransformersEnv {
  allowRemoteModels: boolean;
  cacheDir: string;
}

interface TransformersModule {
  readonly env: TransformersEnv;
  readonly pipeline: (task: "feature-extraction", model: string) => Promise<FeatureExtractor>;
}

/**
 * Kept out of a string literal so the optional native dependency is only
 * resolved when this embedder is actually selected.
 */
const TRANSFORMERS_MODULE: string = "@huggingface/transformers";

const loadExtractor = async (config: TransformersEmbedderConfig): Promise<FeatureExtractor> => {
  const transformers: TransformersModule = await import(TRANSFORMERS_MODULE);
  if (config.cacheDir !== undefined) transformers.env.cacheDir = config.cacheDir;
  transformers.env.allowRemoteModels = !config.offline;
  return transformers.pipeline("feature-extraction", config.model);
};

/**
 * Local ONNX embedder via transformers.js (mean pooling + L2 normalization).
 * The model loads lazily on first use and is reused afterwards.
 */
export const makeTransformersEmbedder = (config: TransformersEmbedderConfig): Embedder => {
  let extractor: Promise<FeatureExtractor> | undefined;
  const getExtractor = (): Promise<FeatureExtractor> => {
    extractor ??= loadExtractor(config);
    return extractor;
  };

  const embedBatch = (batch: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const extract = await getExtractor();
        const rows = (await extract([...batch], { pooling: "mean", normalize: true })).tolist();
        for (const row of rows) {
          if (row.length !== config.dimensions) {
            throw new EmbeddingError({
              message: `model ${config.model} produced ${row.length} dimensions, expected ${config.dimensions}`,
            });
          }
        }
        return rows;
      },
      catch: (cause) =>
        cause instanceof EmbeddingError
          ? cause
          : new EmbeddingError({
              message: `local embedding failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
            }),
    });

  return {
    id: `transformers:${config.model}`,
    dimensions: config.dimensions,
    embed: (texts) =>
      Effect.gen(function* () {
        const out: Array<ReadonlyArray<number>> = [];
        for (let start = 0; start < texts.length; start += config.batchSize) {
          out.push(...(yield* embedBatch(texts.slice(start, start + config.batchSize))));
        }
        return out;
      }),
  };
};
