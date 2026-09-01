import { Effect } from "effect";
import { ValidationError, type CheguersError } from "../errors.js";
import { isLabelName, isRecordId, isRelationshipType } from "../domain/ids.js";
import type { JsonObject, JsonValue } from "../domain/model.js";
import {
  isBooleanValue,
  isJsonArray,
  isNumberValue,
  isPlainObject,
  isStringValue,
} from "../json/runtime.js";
import type { FilterAst, OrderAst, RecordQueryAst, RelatedAst } from "./ast.js";
import { serializeFilterAst } from "./ast.js";
import type { PropertyOperator, RecordQuery, WhereExpression } from "./types.js";

const MAX_HOPS = 3;
const MIN_HOPS = 1;

const COMPARISON_OPS = new Set<string>(["eq", "neq", "gt", "gte", "lt", "lte"]);
const STRING_OPS = new Set<string>(["contains", "startsWith", "endsWith"]);
const MEMBERSHIP_OPS = new Set<string>(["in", "notIn"]);

function fail(message: string): never {
  throw new ValidationError({ message });
}

const isScalarComparable = (value: JsonValue): boolean =>
  value === null || isStringValue(value) || isNumberValue(value) || isBooleanValue(value);

const isPropertyOperator = (op: string): op is PropertyOperator =>
  COMPARISON_OPS.has(op) || STRING_OPS.has(op) || MEMBERSHIP_OPS.has(op) || op === "exists";

const parsePropertyName = (property: JsonValue | undefined): string => {
  if (!isStringValue(property) || property.length === 0 || property.length > 255) {
    fail("query property names must be non-empty strings of at most 255 characters");
  }
  // oxlint-disable-next-line no-control-regex -- reject ASCII control chars in property names
  if (/[\u0000-\u001f]/.test(property)) {
    fail("query property names must not contain control characters");
  }
  return property;
};

const isPropertyLeaf = (expr: JsonObject): boolean => "property" in expr;

const isRelatedLeaf = (expr: JsonObject): boolean => "related" in expr;

const parsePropertyLeaf = (expr: JsonObject): FilterAst => {
  const opRaw = expr.op;
  if (!isStringValue(opRaw)) fail("query property predicates require a string op");
  if (!isPropertyOperator(opRaw)) {
    fail(`unsupported query operator: ${opRaw}`);
  }
  const operator = opRaw;
  const property = parsePropertyName(expr.property);
  const value = expr.value;

  if (operator === "exists") {
    if (value !== undefined && value !== true && value !== false) {
      fail("exists accepts only undefined or a boolean value");
    }
    return {
      kind: "property",
      property,
      op: operator,
      value: value !== false,
    };
  }

  if (MEMBERSHIP_OPS.has(operator)) {
    if (!isJsonArray(value)) fail(`${operator} requires an array of scalar values`);
    for (const entry of value) {
      if (!isScalarComparable(entry)) fail(`${operator} requires an array of scalar values`);
    }
    const sorted = [...value].sort((a, b) => String(a).localeCompare(String(b)));
    return { kind: "property", property, op: operator, value: sorted };
  }

  if (STRING_OPS.has(operator)) {
    if (!isStringValue(value)) fail(`${operator} requires a string value`);
    return { kind: "property", property, op: operator, value };
  }

  if (value === undefined || !isScalarComparable(value)) {
    fail(`${operator} requires a scalar value (string, number, boolean, or null)`);
  }
  return { kind: "property", property, op: operator, value };
};

const parseRelated = (spec: JsonValue): FilterAst => {
  if (!isPlainObject(spec)) {
    fail("related predicates require an object spec");
  }
  const s = spec;
  if (!isStringValue(s.type) || !isRelationshipType(s.type)) {
    fail("related predicates require a valid relationship type");
  }
  if (s.direction !== "outgoing" && s.direction !== "incoming") {
    fail('related predicates require direction "outgoing" or "incoming"');
  }
  const direction = s.direction;
  const relType = s.type;
  const rawMin = s.minHops ?? 1;
  const rawMax = s.maxHops ?? s.minHops ?? 1;
  const minHops = isNumberValue(rawMin) ? rawMin : Number.NaN;
  const maxHops = isNumberValue(rawMax) ? rawMax : Number.NaN;
  if (
    !Number.isInteger(minHops) ||
    minHops < MIN_HOPS ||
    minHops > MAX_HOPS ||
    !Number.isInteger(maxHops) ||
    maxHops < MIN_HOPS ||
    maxHops > MAX_HOPS ||
    minHops > maxHops
  ) {
    fail(`related hops must be integers between ${MIN_HOPS} and ${MAX_HOPS} with min <= max`);
  }
  let where: FilterAst | undefined;
  if (s.where !== undefined) {
    if (!isPlainObject(s.where)) fail("related where must be an object");
    where = parseWhereInput(s.where);
  }
  return {
    kind: "related",
    related: { type: relType, direction, minHops, maxHops, where } satisfies RelatedAst,
  };
};

const sortChildren = (children: ReadonlyArray<FilterAst>): ReadonlyArray<FilterAst> =>
  [...children].sort((a, b) => serializeFilterAst(a).localeCompare(serializeFilterAst(b)));

type LogicalKind = "and" | "or";

const flattenLogical = (kind: LogicalKind, children: ReadonlyArray<FilterAst>): FilterAst => {
  const flattened: Array<FilterAst> = [];
  for (const child of children) {
    if (child.kind === kind) {
      flattened.push(...child.children);
    } else {
      flattened.push(child);
    }
  }
  const unique = new Map<string, FilterAst>();
  for (const child of flattened) {
    unique.set(serializeFilterAst(child), child);
  }
  if (unique.size === 1) {
    const first = [...unique.values()][0]!;
    return first;
  }
  return { kind, children: sortChildren([...unique.values()]) };
};

function parseWhereInput(raw: JsonObject): FilterAst {
  if (!isPlainObject(raw)) {
    fail("where expressions must be objects");
  }
  const e = raw;
  if ("and" in e) {
    const arr = e.and;
    if (!isJsonArray(arr) || arr.length === 0) {
      fail("and requires a non-empty array of expressions");
    }
    const children = arr.map((child) => {
      if (!isPlainObject(child)) fail("and requires an array of object expressions");
      return parseWhereInput(child);
    });
    return flattenLogical("and", children);
  }
  if ("or" in e) {
    const arr = e.or;
    if (!isJsonArray(arr) || arr.length === 0) {
      fail("or requires a non-empty array of expressions");
    }
    const children = arr.map((child) => {
      if (!isPlainObject(child)) fail("or requires an array of object expressions");
      return parseWhereInput(child);
    });
    return flattenLogical("or", children);
  }
  if ("not" in e) {
    if (e.not === undefined || !isPlainObject(e.not)) {
      fail("not requires an object expression");
    }
    return { kind: "not", child: parseWhereInput(e.not) };
  }
  if (isPropertyLeaf(e)) {
    return parsePropertyLeaf(e);
  }
  if (isRelatedLeaf(e)) {
    if (e.related === undefined) {
      fail("related predicates require an object spec");
    }
    return parseRelated(e.related);
  }
  fail("unrecognized where expression shape");
}

export function parseWhereExpression(expr: WhereExpression): FilterAst {
  // SAFETY: every WhereExpression variant is a JSON object tree validated by this parser.
  return parseWhereInput(expr as JsonObject);
}

const parseOrderByInput = (q: RecordQuery): ReadonlyArray<OrderAst> => {
  if (q.orderBy === undefined) return [];
  if (!Array.isArray(q.orderBy)) fail("orderBy must be an array");
  return q.orderBy.map((entry) => {
    if (!isPlainObject(entry)) {
      fail("orderBy entries must be objects");
    }
    const property = entry.property === undefined ? undefined : parsePropertyName(entry.property);
    if (property === undefined) fail("orderBy entries require a property");
    if (entry.direction !== undefined && entry.direction !== "asc" && entry.direction !== "desc") {
      fail('orderBy direction must be "asc" or "desc"');
    }
    return {
      property,
      direction: entry.direction === "desc" ? ("desc" as const) : ("asc" as const),
    };
  });
};

export const parseRecordQuery = (
  query: RecordQuery,
): Effect.Effect<RecordQueryAst, CheguersError> =>
  Effect.sync(() => {
    let id: string | undefined;
    if (query.id !== undefined) {
      if (!isStringValue(query.id) || !isRecordId(query.id)) {
        fail(`invalid record id in query: ${String(query.id)}`);
      }
      id = query.id;
    }
    let labels: ReadonlyArray<string> = [];
    if (query.labels !== undefined) {
      if (!Array.isArray(query.labels) || query.labels.some((l) => !isLabelName(l))) {
        fail("query labels must be an array of valid label names");
      }
      labels = [...new Set(query.labels)].sort();
    }
    const where = query.where === undefined ? undefined : parseWhereExpression(query.where);
    const orderBy = parseOrderByInput(query);
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      fail("limit must be a non-negative integer");
    }
    if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
      fail("offset must be a non-negative integer");
    }
    return {
      id,
      labels,
      where,
      orderBy,
      limit: query.limit,
      offset: query.offset,
    } satisfies RecordQueryAst;
  }).pipe(
    Effect.mapError((cause: unknown): CheguersError =>
      cause instanceof ValidationError
        ? cause
        : new ValidationError({ message: "invalid query", cause }),
    ),
  );

// re-export for callers that need hop bounds alongside the AST module
export { MAX_HOPS as QUERY_MAX_HOPS, MIN_HOPS as QUERY_MIN_HOPS };
