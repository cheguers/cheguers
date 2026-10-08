import { Schema } from "effect";

/**
 * Failure surfaced to MCP clients as a tool error result. The message is
 * forwarded verbatim, so it must be actionable for an agent ("record id
 * rec_x not found"), never a stack trace.
 */
export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  message: Schema.String,
}) {}

/** Embedding provider failure (network, model load, malformed response). */
export class EmbeddingError extends Schema.TaggedError<EmbeddingError>()("EmbeddingError", {
  message: Schema.String,
}) {}
