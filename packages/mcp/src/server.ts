import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { makeCheguersBackend } from "./backend/cheguers.js";
import { makeNotesBackend } from "./backend/notes.js";
import type { MemoryBackend } from "./backend/types.js";
import { describeEmbedder, type ServerSettings } from "./config.js";
import { makeEmbedder } from "./embedding/index.js";
import type { MemoryError } from "./errors.js";
import { makeTelemetry } from "./telemetry.js";
import {
  MemoryBackendService,
  MemoryToolkit,
  MemoryToolkitHandlers,
  TelemetryService,
} from "./tools.js";

export const SERVER_NAME = "cheguers-memory";
export const SERVER_VERSION = "0.1.0";

export const makeBackend = (settings: ServerSettings): Effect.Effect<MemoryBackend, MemoryError> =>
  settings.backend === "notes"
    ? Effect.succeed(makeNotesBackend())
    : makeCheguersBackend({
        dbPath: settings.dbPath,
        embedder: makeEmbedder(settings.embedder),
        retrieval: settings.backend === "cheguers" ? "hybrid" : "vector",
      });

const backendLayer = (settings: ServerSettings) =>
  Layer.effect(
    MemoryBackendService,
    Effect.acquireRelease(makeBackend(settings), (backend) => backend.close),
  );

/**
 * Telemetry depends on the backend so its finalizer (final stats + summary
 * line) runs before the backend closes.
 */
const telemetryLayer = (settings: ServerSettings) =>
  Layer.effect(
    TelemetryService,
    Effect.gen(function* () {
      const backend = yield* MemoryBackendService;
      const telemetry = makeTelemetry(settings.telemetryDir, settings.runId);
      yield* telemetry.start({
        backend: settings.backend,
        embedder: describeEmbedder(settings),
        dimensions: settings.backend === "notes" ? null : settings.embedder.dimensions,
        dbPath: settings.backend === "notes" ? null : settings.dbPath,
      });
      yield* Effect.addFinalizer(() =>
        backend.stats.pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap(telemetry.finish),
        ),
      );
      return telemetry;
    }),
  );

/** Backend + telemetry services for the tool handlers. */
export const memoryLayer = (settings: ServerSettings) =>
  telemetryLayer(settings).pipe(Layer.provideMerge(backendLayer(settings)));

const healthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

/**
 * MCP routes (Streamable HTTP at `settings.path`) plus `GET /health`, fully
 * wired to the memory services. Only an `HttpRouter` is left to provide, so
 * the same layer runs behind a Node server or `HttpRouter.toWebHandler`.
 */
export const appLayer = (settings: ServerSettings) =>
  Layer.mergeAll(
    McpServer.toolkit(MemoryToolkit).pipe(Layer.provideMerge(MemoryToolkitHandlers)),
    healthRoute,
  ).pipe(
    Layer.provide(
      McpServer.layerHttp({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        description: "Persistent task memory backed by CheguersDB (graph + vector)",
        path: settings.path,
        protocols: [
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
      }),
    ),
    Layer.provide(memoryLayer(settings)),
  );

/** Node HTTP server listening on `settings.host:settings.port`. */
export const serverLayer = (settings: ServerSettings) =>
  HttpRouter.serve(appLayer(settings), { disableLogger: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: settings.port, host: settings.host })),
  );
