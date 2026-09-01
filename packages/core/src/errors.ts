import { Data } from "effect";
import {
  isStringValue,
  objectTag,
  type RuntimeTagInput,
  type UnparsedJsonObject,
} from "./json/runtime.js";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly kind: "record" | "relationship" | "vector";
  readonly id: string;
}> {
  get detail(): string {
    return `${this.kind} ${this.id} not found`;
  }
}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
}> {}

export type CheguersError =
  | DatabaseError
  | TransactionError
  | ValidationError
  | NotFoundError
  | ConflictError;

export const errorTags = [
  "DatabaseError",
  "TransactionError",
  "ValidationError",
  "NotFoundError",
  "ConflictError",
] as const;

const ERROR_TAG_SET = new Set<string>(errorTags);

export const isCheguersError = (cause: unknown): cause is CheguersError => {
  if (cause === null || cause === undefined || Array.isArray(cause)) return false;
  // SAFETY: object-tag gate limits `_tag` reads to record-like Effect error values.
  const record = cause as RuntimeTagInput;
  const classTag = objectTag(record);
  if (classTag !== "[object Object]" && classTag !== "[object Error]") return false;
  if (!("_tag" in Object(record))) return false;
  // SAFETY: `_tag` membership on a record-tagged value exposes the tagged-error label field.
  const tag = (record as UnparsedJsonObject)._tag;
  return isStringValue(tag) && ERROR_TAG_SET.has(tag);
};
