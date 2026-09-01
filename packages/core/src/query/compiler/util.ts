import type { ComparisonOperator, StringOperator, MembershipOperator } from "../ast.js";

export interface CompileContext {
  /** Alias of the record row the current filter applies to. */
  readonly alias: string;
}

export interface CompiledFragment {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | boolean | null>;
}

export const PROPERTY_OPERATORS_COMPARISON: ReadonlySet<ComparisonOperator> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export const PROPERTY_OPERATORS_STRING: ReadonlySet<StringOperator> = new Set([
  "contains",
  "startsWith",
  "endsWith",
]);

export const PROPERTY_OPERATORS_MEMBERSHIP: ReadonlySet<MembershipOperator> = new Set([
  "in",
  "notIn",
]);

/**
 * Builds a JSON path parameter for a top-level property name.
 * Quoting handles keys containing dots, quotes, and other JSON-special chars.
 */
export const jsonPathParam = (property: string): string =>
  `$."${property.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const escapeLikePattern = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

export const compileLikePattern = (value: string, operator: StringOperator): string => {
  const escaped = escapeLikePattern(value);
  if (operator === "contains") return `%${escaped}%`;
  if (operator === "startsWith") return `${escaped}%`;
  return `%${escaped}`;
};
