import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import type { JsonArray, JsonObject, JsonValue } from "../domain/model.js";
import { serializeFilterAst, type FilterAst } from "./ast.js";
import { parseWhereExpression } from "./parser.js";
import type { WhereExpression } from "./types.js";

const LABEL_KEY = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(s));

const SCALAR: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** Recursively build valid where expressions. */
const whereExpr = fc.letrec((tie) => {
  // SAFETY: fast-check record shapes match the WhereExpression property-leaf variants.
  const leaf = fc.record({
    property: LABEL_KEY,
    op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte"),
    value: SCALAR,
  }) as fc.Arbitrary<WhereExpression>;

  // SAFETY: fast-check record shapes match the WhereExpression string-leaf variants.
  const stringLeaf = fc.record({
    property: LABEL_KEY,
    op: fc.constantFrom("contains", "startsWith", "endsWith"),
    value: fc.string({ maxLength: 8 }),
  }) as fc.Arbitrary<WhereExpression>;

  // SAFETY: fast-check record shapes match the WhereExpression exists-leaf variant.
  const existsLeaf = fc.record({
    property: LABEL_KEY,
    op: fc.constant("exists" as const),
  }) as fc.Arbitrary<WhereExpression>;

  // SAFETY: fast-check recursive generators produce valid logical WhereExpression trees.
  const logical = fc.oneof(
    fc.record({
      and: fc.array(tie("expr") as fc.Arbitrary<WhereExpression>, { minLength: 1, maxLength: 4 }),
    }),
    fc.record({
      or: fc.array(tie("expr") as fc.Arbitrary<WhereExpression>, { minLength: 1, maxLength: 4 }),
    }),
    fc.record({ not: tie("expr") as fc.Arbitrary<WhereExpression> }),
  ) as fc.Arbitrary<WhereExpression>;

  return {
    expr: fc.oneof({ depthSize: "small" }, leaf, stringLeaf, existsLeaf, logical),
  };
});

const astToExpression = (ast: FilterAst): WhereExpression => {
  switch (ast.kind) {
    case "property":
      if (ast.op === "exists") {
        return { property: ast.property, op: ast.op };
      }
      if (ast.value === undefined) {
        return { property: ast.property, op: ast.op };
      }
      return { property: ast.property, op: ast.op, value: ast.value };
    case "related": {
      type RelatedExpressionDraft = {
        type: string;
        direction: "outgoing" | "incoming";
        where?: WhereExpression;
      };
      const related: RelatedExpressionDraft = {
        type: ast.related.type,
        direction: ast.related.direction,
      };
      if (ast.related.where !== undefined) {
        related.where = astToExpression(ast.related.where);
      }
      return { related };
    }
    case "and":
      return { and: ast.children.map(astToExpression) };
    case "or":
      return { or: ast.children.map(astToExpression) };
    case "not":
      return { not: astToExpression(ast.child) };
  }
};

describe("query parser properties", () => {
  // SAFETY: letrec exposes expr as Arbitrary<WhereExpression> for property tests.
  const exprArb = whereExpr.expr as fc.Arbitrary<WhereExpression>;

  it("parses every generated expression without throwing", () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        expect(() => parseWhereExpression(expr)).not.toThrow();
      }),
    );
  });

  it("is deterministic: parsing twice yields identical ASTs", () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const first = serializeFilterAst(parseWhereExpression(expr));
        const second = serializeFilterAst(parseWhereExpression(expr));
        expect(first).toEqual(second);
      }),
    );
  });

  it("is idempotent: re-parsing a normalized AST yields an identical AST", () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const ast = parseWhereExpression(expr);
        const reparsed = parseWhereExpression(astToExpression(ast));
        expect(serializeFilterAst(reparsed)).toEqual(serializeFilterAst(ast));
      }),
    );
  });

  it("normalizes membership values to sorted order", () => {
    fc.assert(
      fc.property(
        LABEL_KEY,
        fc.array(SCALAR, { minLength: 1, maxLength: 8 }),
        (property, values) => {
          const ast = parseWhereExpression({
            property,
            op: "in",
            value: values satisfies JsonArray,
          });
          if (ast.kind !== "property") return;
          const sorted = [...values].sort((a, b) => String(a).localeCompare(String(b)));
          expect(ast.value).toEqual(sorted);
        },
      ),
    );
  });

  it("flattens duplicate children in and/or expressions", () => {
    fc.assert(
      fc.property(LABEL_KEY, SCALAR, fc.integer({ min: 2, max: 5 }), (property, value, n) => {
        const child: WhereExpression = {
          property,
          op: "eq",
          value,
        };
        const ast = parseWhereExpression({ and: Array.from({ length: n }, () => child) });
        if (ast.kind === "and") {
          expect(ast.children).toHaveLength(1);
        } else {
          expect(ast).toEqual({ kind: "property", property, op: "eq", value });
        }
      }),
    );
  });

  it("rejects invalid operator and value shapes", () => {
    const invalid = fc.oneof(
      fc.record({
        property: LABEL_KEY,
        op: fc.constantFrom("regex", "~~", "BETWEEN"),
        value: SCALAR,
      }),
      fc.record({
        property: LABEL_KEY,
        op: fc.constantFrom("contains", "startsWith", "endsWith"),
        value: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
      }),
      fc.record({ property: LABEL_KEY, op: fc.constantFrom("in", "notIn"), value: SCALAR }),
      fc.record({
        property: LABEL_KEY,
        op: fc.constant("eq"),
        value: fc.constant({ nested: true } satisfies JsonObject),
      }),
      fc.constant("not-an-expression"),
      fc.constant({}),
    );
    fc.assert(
      fc.property(invalid, (expr) => {
        // SAFETY: invalid generator shapes are intentionally widened to exercise parser rejection.
        expect(() => parseWhereExpression(expr as WhereExpression)).toThrow(ValidationError);
      }),
    );
  });
});
