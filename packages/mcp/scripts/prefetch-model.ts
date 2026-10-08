/**
 * Downloads the local embedding model into CHEGUERS_EMBED_CACHE_DIR and runs
 * one warm-up embedding, so containers can start with CHEGUERS_EMBED_OFFLINE=true.
 * Used at image build time: `tsx packages/mcp/scripts/prefetch-model.ts`.
 */
import { Effect } from "effect";
import { ServerConfig } from "../src/config.js";
import { makeTransformersEmbedder } from "../src/embedding/transformers.js";

const program = Effect.gen(function* () {
  const settings = yield* ServerConfig;
  const embedder = makeTransformersEmbedder({
    model: settings.embedder.model,
    dimensions: settings.embedder.dimensions,
    batchSize: 1,
    cacheDir: settings.embedder.cacheDir,
    offline: false,
  });
  const [vector] = yield* embedder.embed(["warm-up"]);
  yield* Effect.logInfo(
    `prefetched ${settings.embedder.model} (${vector?.length ?? 0} dims) into ${settings.embedder.cacheDir ?? "default cache"}`,
  );
});

Effect.runPromise(program).catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
