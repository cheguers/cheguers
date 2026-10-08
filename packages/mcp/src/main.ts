#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { ServerConfig, describeEmbedder } from "./config.js";
import { serverLayer } from "./server.js";

const program = Effect.gen(function* () {
  const settings = yield* ServerConfig;
  yield* Effect.logInfo(
    `cheguers-mcp backend=${settings.backend} embedder=${describeEmbedder(settings)} listening on http://${settings.host}:${settings.port}${settings.path}`,
  );
  return yield* Layer.launch(serverLayer(settings));
});

NodeRuntime.runMain(program);
