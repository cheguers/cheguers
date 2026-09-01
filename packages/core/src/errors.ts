import { Data } from "effect"

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string
  readonly cause?: unknown
}> {}

export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly operation: string
  readonly cause?: unknown
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly kind: "record" | "relationship" | "vector"
  readonly id: string
}> {
  get detail(): string {
    return `${this.kind} ${this.id} not found`
  }
}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string
}> {}

export type CheguersError =
  | DatabaseError
  | TransactionError
  | ValidationError
  | NotFoundError
  | ConflictError

export const errorTags = [
  "DatabaseError",
  "TransactionError",
  "ValidationError",
  "NotFoundError",
  "ConflictError"
] as const

export const isCheguersError = (u: unknown): u is CheguersError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  (errorTags as ReadonlyArray<string>).includes((u as { _tag: string })._tag)
