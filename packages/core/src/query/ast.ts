import type { JsonValue } from "../domain/model.js";

export type ComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export type StringOperator = "contains" | "startsWith" | "endsWith";

export type MembershipOperator = "in" | "notIn";

export type AstOperator = ComparisonOperator | StringOperator | MembershipOperator | "exists";

export type Direction = "outgoing" | "incoming";

export interface RelatedAst {
  readonly type: string;
  readonly direction: Direction;
  readonly minHops: number;
  readonly maxHops: number;
  readonly where: FilterAst | undefined;
}

export type FilterAst =
  | {
      readonly kind: "property";
      readonly property: string;
      readonly op: AstOperator;
      readonly value: JsonValue | undefined;
    }
  | { readonly kind: "related"; readonly related: RelatedAst }
  | { readonly kind: "and"; readonly children: ReadonlyArray<FilterAst> }
  | { readonly kind: "or"; readonly children: ReadonlyArray<FilterAst> }
  | { readonly kind: "not"; readonly child: FilterAst };

export interface OrderAst {
  readonly property: string;
  readonly direction: "asc" | "desc";
}

export interface RecordQueryAst {
  readonly id: string | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly where: FilterAst | undefined;
  readonly orderBy: ReadonlyArray<OrderAst>;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/** Canonical serialization used to sort children for stable SQL generation. */
export const serializeFilterAst = (node: FilterAst): string => {
  switch (node.kind) {
    case "property":
      return JSON.stringify(["property", node.property, node.op, node.value ?? null]);
    case "related":
      return JSON.stringify([
        "related",
        node.related.type,
        node.related.direction,
        node.related.minHops,
        node.related.maxHops,
        node.related.where === undefined
          ? null
          : JSON.parse(serializeFilterAst(node.related.where)),
      ]);
    case "and":
    case "or":
      return JSON.stringify([
        node.kind,
        ...node.children.map((c) => JSON.parse(serializeFilterAst(c))),
      ]);
    case "not":
      return JSON.stringify(["not", JSON.parse(serializeFilterAst(node.child))]);
  }
};
