import { Effect } from "effect"
import { ValidationError, type CheguersError } from "../errors.js"
import {
  isLabelName,
  isRecordId,
  isRelationshipType
} from "../domain/ids.js"
import type { JsonValue } from "../domain/model.js"
import type {
  FilterAst,
  OrderAst,
  RecordQueryAst,
  RelatedAst
} from "./ast.js"
import { serializeFilterAst } from "./ast.js"
import type { PropertyOperator, RecordQuery, WhereExpression } from "./types.js"

const MAX_HOPS = 3
const MIN_HOPS = 1

const COMPARISON_OPS = new Set<string>(["eq", "neq", "gt", "gte", "lt", "lte"])
const STRING_OPS = new Set<string>(["contains", "startsWith", "endsWith"])
const MEMBERSHIP_OPS = new Set<string>(["in", "notIn"])

function fail(message: string): never {
  throw new ValidationError({ message })
}

const isScalarComparable = (value: JsonValue): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"

const validatePropertyName = (property: unknown): string => {
  if (
    typeof property !== "string" ||
    property.length === 0 ||
    property.length > 255
  ) {
    fail("query property names must be non-empty strings of at most 255 characters")
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(property)) {
    fail("query property names must not contain control characters")
  }
  return property
}

const isPropertyLeaf = (
  expr: Record<string, unknown>
): boolean => "property" in expr

const isRelatedLeaf = (expr: Record<string, unknown>): boolean =>
  "related" in expr

const parsePropertyLeaf = (expr: Record<string, unknown>): FilterAst => {
  const op = expr.op
  if (typeof op !== "string") fail("query property predicates require a string op")
  if (
    !COMPARISON_OPS.has(op) &&
    !STRING_OPS.has(op) &&
    !MEMBERSHIP_OPS.has(op) &&
    op !== "exists"
  ) {
    fail(`unsupported query operator: ${op}`)
  }
  const operator = op as PropertyOperator
  const property = validatePropertyName(expr.property)
  const value = expr.value as JsonValue | undefined

  if (operator === "exists") {
    if (value !== undefined && value !== true && value !== false) {
      fail("exists accepts only undefined or a boolean value")
    }
    return {
      kind: "property",
      property,
      op: operator,
      value: value !== false
    }
  }

  if (MEMBERSHIP_OPS.has(operator)) {
    if (!Array.isArray(value)) fail(`${operator} requires an array of scalar values`)
    const arr = value as ReadonlyArray<JsonValue>
    for (const v of arr) {
      if (!isScalarComparable(v)) fail(`${operator} requires an array of scalar values`)
    }
    const sorted = [...arr].sort((a, b) =>
      String(a).localeCompare(String(b))
    ) as JsonValue
    return { kind: "property", property, op: operator, value: sorted }
  }

  if (STRING_OPS.has(operator)) {
    if (typeof value !== "string") fail(`${operator} requires a string value`)
    return { kind: "property", property, op: operator, value }
  }

  if (!isScalarComparable(value as JsonValue)) {
    fail(`${operator} requires a scalar value (string, number, boolean, or null)`)
  }
  return { kind: "property", property, op: operator, value }
}

const parseRelated = (spec: unknown): FilterAst => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    fail("related predicates require an object spec")
  }
  const s = spec as Record<string, unknown>
  if (typeof s.type !== "string" || !isRelationshipType(s.type)) {
    fail("related predicates require a valid relationship type")
  }
  if (s.direction !== "outgoing" && s.direction !== "incoming") {
    fail('related predicates require direction "outgoing" or "incoming"')
  }
  const direction = s.direction as "outgoing" | "incoming"
  const relType = s.type as string
  const rawMin = s.minHops ?? 1
  const rawMax = s.maxHops ?? s.minHops ?? 1
  const minHops = typeof rawMin === "number" ? rawMin : Number.NaN
  const maxHops = typeof rawMax === "number" ? rawMax : Number.NaN
  if (
    !Number.isInteger(minHops) ||
    minHops < MIN_HOPS ||
    minHops > MAX_HOPS ||
    !Number.isInteger(maxHops) ||
    maxHops < MIN_HOPS ||
    maxHops > MAX_HOPS ||
    minHops > maxHops
  ) {
    fail(`related hops must be integers between ${MIN_HOPS} and ${MAX_HOPS} with min <= max`)
  }
  let where: FilterAst | undefined
  if (s.where !== undefined) {
    where = parseWhereExpression(s.where as WhereExpression)
  }
  return {
    kind: "related",
    related: { type: relType, direction, minHops, maxHops, where } satisfies RelatedAst
  }
}

const sortChildren = (children: ReadonlyArray<FilterAst>): ReadonlyArray<FilterAst> =>
  [...children].sort(
    (a, b) => serializeFilterAst(a).localeCompare(serializeFilterAst(b))
  )

type LogicalKind = "and" | "or"

const flattenLogical = (
  kind: LogicalKind,
  children: ReadonlyArray<FilterAst>
): FilterAst => {
  const flattened: Array<FilterAst> = []
  for (const child of children) {
    if (child.kind === kind) {
      flattened.push(...child.children)
    } else {
      flattened.push(child)
    }
  }
  const unique = new Map<string, FilterAst>()
  for (const child of flattened) {
    unique.set(serializeFilterAst(child), child)
  }
  if (unique.size === 1) {
    const first = [...unique.values()][0]!
    return first
  }
  return { kind, children: sortChildren([...unique.values()]) }
}

export function parseWhereExpression(expr: WhereExpression): FilterAst {
  if (typeof expr !== "object" || expr === null || Array.isArray(expr)) {
    fail("where expressions must be objects")
  }
  const e = expr as unknown as Record<string, unknown>
  if ("and" in e) {
    const arr = e.and
    if (!Array.isArray(arr) || arr.length === 0) {
      fail("and requires a non-empty array of expressions")
    }
    const children = (arr as ReadonlyArray<WhereExpression>).map(parseWhereExpression)
    return flattenLogical("and", children)
  }
  if ("or" in e) {
    const arr = e.or
    if (!Array.isArray(arr) || arr.length === 0) {
      fail("or requires a non-empty array of expressions")
    }
    const children = (arr as ReadonlyArray<WhereExpression>).map(parseWhereExpression)
    return flattenLogical("or", children)
  }
  if ("not" in e) {
    return { kind: "not", child: parseWhereExpression(e.not as WhereExpression) }
  }
  if (isPropertyLeaf(e)) {
    return parsePropertyLeaf(e)
  }
  if (isRelatedLeaf(e)) {
    return parseRelated(e.related)
  }
  fail("unrecognized where expression shape")
}

const parseOrderByInput = (q: RecordQuery): ReadonlyArray<OrderAst> => {
  if (q.orderBy === undefined) return []
  if (!Array.isArray(q.orderBy)) fail("orderBy must be an array")
  return q.orderBy.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      fail("orderBy entries must be objects")
    }
    const o = entry as Record<string, unknown>
    const property = o.property === undefined ? undefined : validatePropertyName(o.property)
    if (property === undefined) fail("orderBy entries require a property")
    if (o.direction !== undefined && o.direction !== "asc" && o.direction !== "desc") {
      fail('orderBy direction must be "asc" or "desc"')
    }
    return {
      property,
      direction: o.direction === "desc" ? ("desc" as const) : ("asc" as const)
    }
  })
}

export const parseRecordQuery = (
  query: RecordQuery
): Effect.Effect<RecordQueryAst, CheguersError> =>
  Effect.sync(() => {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      fail("record queries must be objects")
    }
    let id: string | undefined
    if (query.id !== undefined) {
      if (typeof query.id !== "string" || !isRecordId(query.id)) {
        fail(`invalid record id in query: ${String(query.id)}`)
      }
      id = query.id
    }
    let labels: ReadonlyArray<string> = []
    if (query.labels !== undefined) {
      if (!Array.isArray(query.labels) || query.labels.some((l) => !isLabelName(l))) {
        fail("query labels must be an array of valid label names")
      }
      labels = [...new Set(query.labels)].sort()
    }
    const where =
      query.where === undefined ? undefined : parseWhereExpression(query.where)
    const orderBy = parseOrderByInput(query)
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      fail("limit must be a non-negative integer")
    }
    if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
      fail("offset must be a non-negative integer")
    }
    return {
      id,
      labels,
      where,
      orderBy,
      limit: query.limit,
      offset: query.offset
    } satisfies RecordQueryAst
  }).pipe(
    Effect.mapError((error: unknown): CheguersError =>
      error instanceof ValidationError
        ? error
        : new ValidationError({ message: "invalid query", cause: error })
    )
  )

// re-export for callers that need hop bounds alongside the AST module
export { MAX_HOPS as QUERY_MAX_HOPS, MIN_HOPS as QUERY_MIN_HOPS }
