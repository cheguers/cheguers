export {
  makeCheguersBackend,
  MEMORY_NAMESPACE,
  type CheguersBackendConfig,
} from "./backend/cheguers.js";
export { makeNotesBackend } from "./backend/notes.js";
export type * from "./backend/types.js";
export { BACKEND_KINDS, SNIPPET_CHARS } from "./backend/types.js";
export { chunkText, DEFAULT_CHUNKING, type ChunkingOptions, type TextChunk } from "./chunking.js";
export { ServerConfig, type ServerSettings } from "./config.js";
export * from "./embedding/index.js";
export { EmbeddingError, MemoryError } from "./errors.js";
export {
  appLayer,
  makeBackend,
  memoryLayer,
  serverLayer,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export {
  makeTelemetry,
  type Telemetry,
  type TelemetrySummary,
  type ToolCallEvent,
} from "./telemetry.js";
export { MemoryBackendService, MemoryToolkit, TelemetryService } from "./tools.js";
