import { hostname } from "node:os";
import { Config, Effect, Option, Redacted } from "effect";
import { BACKEND_KINDS, type BackendKind } from "./backend/types.js";
import type { EmbedderProvider, EmbedderSettings } from "./embedding/index.js";

export const DEFAULT_PORT = 8765;
export const DEFAULT_MCP_PATH = "/mcp";
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_EMBED_DIMENSIONS = 384;

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  readonly path: `/${string}`;
  readonly backend: BackendKind;
  readonly dbPath: string;
  readonly embedder: EmbedderSettings;
  readonly telemetryDir: string | undefined;
  readonly runId: string;
}

const EMBEDDER_PROVIDERS: ReadonlyArray<EmbedderProvider> = ["transformers", "openai", "hash"];

const optionalString = (name: string) =>
  Config.option(Config.nonEmptyString(name)).pipe(Config.map(Option.getOrUndefined));

const toMcpPath = (raw: string): `/${string}` =>
  raw.startsWith("/") ? `/${raw.slice(1)}` : `/${raw}`;

const defaultRunId = (): string =>
  `${hostname()}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;

/** Server configuration read from `CHEGUERS_*` environment variables. */
export const ServerConfig: Config.Config<ServerSettings> = Config.all({
  host: Config.string("CHEGUERS_MCP_HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.port("CHEGUERS_MCP_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  path: Config.string("CHEGUERS_MCP_PATH").pipe(Config.withDefault(DEFAULT_MCP_PATH)),
  backend: Config.literals(BACKEND_KINDS, "CHEGUERS_BACKEND").pipe(
    Config.withDefault<BackendKind>("cheguers"),
  ),
  dbPath: Config.string("CHEGUERS_DB_PATH").pipe(Config.withDefault("./cheguers-memory.db")),
  provider: Config.literals(EMBEDDER_PROVIDERS, "CHEGUERS_EMBEDDER").pipe(
    Config.withDefault<EmbedderProvider>("transformers"),
  ),
  model: Config.string("CHEGUERS_EMBED_MODEL").pipe(Config.withDefault(DEFAULT_EMBED_MODEL)),
  dimensions: Config.int("CHEGUERS_EMBED_DIMENSIONS").pipe(
    Config.withDefault(DEFAULT_EMBED_DIMENSIONS),
  ),
  batchSize: Config.int("CHEGUERS_EMBED_BATCH").pipe(Config.withDefault(32)),
  cacheDir: optionalString("CHEGUERS_EMBED_CACHE_DIR"),
  offline: Config.boolean("CHEGUERS_EMBED_OFFLINE").pipe(Config.withDefault(false)),
  baseUrl: Config.string("CHEGUERS_EMBED_BASE_URL").pipe(
    Config.withDefault("https://api.openai.com/v1"),
  ),
  apiKey: Config.option(Config.redacted("OPENAI_API_KEY")).pipe(
    Config.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
  ),
  telemetryDir: optionalString("CHEGUERS_TELEMETRY_DIR"),
  runId: optionalString("CHEGUERS_RUN_ID"),
}).pipe(
  Config.map(
    (raw): ServerSettings => ({
      host: raw.host,
      port: raw.port,
      path: toMcpPath(raw.path),
      backend: raw.backend,
      dbPath: raw.dbPath,
      embedder: {
        provider: raw.provider,
        model: raw.model,
        dimensions: raw.dimensions,
        batchSize: Math.max(1, raw.batchSize),
        cacheDir: raw.cacheDir,
        offline: raw.offline,
        baseUrl: raw.baseUrl,
        apiKey: raw.apiKey,
      },
      telemetryDir: raw.telemetryDir,
      runId: raw.runId ?? defaultRunId(),
    }),
  ),
);

/** Human-readable embedder identity for logs and telemetry; `none` for the notes arm. */
export const describeEmbedder = (settings: ServerSettings): string => {
  if (settings.backend === "notes") return "none";
  const embedder = settings.embedder;
  return embedder.provider === "hash"
    ? `hash-${embedder.dimensions}`
    : `${embedder.provider}:${embedder.model}`;
};

export const loadServerSettings = Effect.gen(function* () {
  return yield* ServerConfig;
});
