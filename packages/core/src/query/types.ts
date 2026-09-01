import type { JsonValue } from "../domain/model.js"

export type ComparisonOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"

export type StringOperator = "contains" | "startsWith" | "endsWith"

export type MembershipOperator = "in" | "notIn"

export type PropertyOperator =
  | ComparisonOperator
  | StringOperator
  | MembershipOperator
  | "exists"

export interface RelatedSpec {
  readonly type: string
  readonly direction: "outgoing" | "incoming"
  readonly minHops?: number
  readonly maxHops?: number
  readonly where?: WhereExpression
}

export type WhereExpression =
  | { readonly and: ReadonlyArray<WhereExpression> }
  | { readonly or: ReadonlyArray<WhereExpression> }
  | { readonly not: WhereExpression }
  | { readonly property: string; readonly op: PropertyOperator; readonly value?: JsonValue }
  | { readonly related: RelatedSpec }

export interface OrderBy {
  readonly property: string
  readonly direction: "asc" | "desc"
}

export interface RecordQuery {
  readonly id?: string
  readonly labels?: ReadonlyArray<string>
  readonly where?: WhereExpression
  readonly orderBy?: ReadonlyArray<OrderBy>
  readonly limit?: number
  readonly offset?: number
}
