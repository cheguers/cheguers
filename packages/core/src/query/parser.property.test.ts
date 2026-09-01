import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { ValidationError } from "../errors.js"
import type { JsonValue } from "../domain/model.js"
import { serializeFilterAst, type FilterAst } from "./ast.js"
import { parseWhereExpression } from "./parser.js"
import type { WhereExpression } from "./types.js"

const LABEL_KEY = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(s))

const SCALAR: fc.Arbitrary<fc.JsonValue> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null)
)

/** Recursively build valid where expressions. */
const whereExpr = fc.letrec((tie) => {
  const leaf: fc.Arbitrary<WhereExpression> = fc.record({
    property: LABEL_KEY,
    op: fc.constantFrom(
      "eq", "neq", "gt", "gte", "lt", "lte"
    ),
    value: SCALAR
  }) as fc.Arbitrary<WhereExpression>

  const stringLeaf: fc.Arbitrary<WhereExpression> = fc
    .record({
      property: LABEL_KEY,
      op: fc.constantFrom("contains", "startsWith", "endsWith"),
      value: fc.string({ maxLength: 8 })
    }) as unknown as fc.Arbitrary<WhereExpression>

  const existsLeaf: fc.Arbitrary<WhereExpression> = fc
    .record({
      property: LABEL_KEY,
      op: fc.constant("exists"),
      value: fc.constant(undefined)
    }) as unknown as fc.Arbitrary<WhereExpression>

  const logical: fc.Arbitrary<WhereExpression> = fc.oneof(
    fc.record({ and: fc.array(tie("expr") as fc.Arbitrary<WhereExpression>, { minLength: 1, maxLength: 4 }) }),
    fc.record({ or: fc.array(tie("expr") as fc.Arbitrary<WhereExpression>, { minLength: 1, maxLength: 4 }) }),
    fc.record({ not: tie("expr") as fc.Arbitrary<WhereExpression> })
  ) as fc.Arbitrary<WhereExpression>

  return {
    expr: fc.oneof({ depthSize: "small" }, leaf, stringLeaf, existsLeaf, logical),
    logical
  }
})

const astToExpression = (ast: FilterAst): WhereExpression => {
  switch (ast.kind) {
    case "property":
      return {
        property: ast.property,
        op: ast.op,
        ...(ast.op === "exists" ? {} : { value: ast.value as unknown as JsonValue })
      }
    case "related":
      return {
        related: {
          type: ast.related.type,
          direction: ast.related.direction,
          ...(ast.related.where !== undefined
            ? { where: astToExpression(ast.related.where) }
            : {})
        }
      }
    case "and":
      return { and: ast.children.map(astToExpression) }
    case "or":
      return { or: ast.children.map(astToExpression) }
    case "not":
      return { not: astToExpression(ast.child) }
  }
}

describe("query parser properties", () => {
  it("parses every generated expression without throwing", () => {
    fc.assert(
      fc.property(whereExpr.expr, (expr) => {
        expect(() => parseWhereExpression(expr)).not.toThrow()
      })
    )
  })

  it("is deterministic: parsing twice yields identical ASTs", () => {
    fc.assert(
      fc.property(whereExpr.expr, (expr) => {
        const first = serializeFilterAst(parseWhereExpression(expr))
        const second = serializeFilterAst(parseWhereExpression(expr))
        expect(first).toEqual(second)
      })
    )
  })

  it("is idempotent: re-parsing a normalized AST yields an identical AST", () => {
    fc.assert(
      fc.property(whereExpr.expr, (expr) => {
        const ast = parseWhereExpression(expr)
        const reparsed = parseWhereExpression(astToExpression(ast))
        expect(serializeFilterAst(reparsed)).toEqual(serializeFilterAst(ast))
      })
    )
  })

  it("normalizes membership values to sorted order", () => {
    fc.assert(
      fc.property(
        LABEL_KEY,
        fc.array(SCALAR, { minLength: 1, maxLength: 8 }),
        (property, values) => {
          const ast = parseWhereExpression({
            property,
            op: "in",
            value: values as unknown as JsonValue
          })
          if (ast.kind !== "property") return
          const sorted = [...values].sort((a, b) => String(a).localeCompare(String(b)))
          expect(ast.value).toEqual(sorted)
        }
      )
    )
  })

  it("flattens duplicate children in and/or expressions", () => {
    fc.assert(
      fc.property(LABEL_KEY, SCALAR, fc.integer({ min: 2, max: 5 }), (property, value, n) => {
        const child: WhereExpression = {
          property,
          op: "eq",
          value: value as unknown as JsonValue
        }
        const ast = parseWhereExpression({ and: Array.from({ length: n }, () => child) })
        if (ast.kind === "and") {
          expect(ast.children).toHaveLength(1)
        } else {
          expect(ast).toEqual({ kind: "property", property, op: "eq", value })
        }
      })
    )
  })

  it("rejects invalid operator and value shapes", () => {
    const invalid = fc.oneof(
      // unknown operator
      fc.record({ property: LABEL_KEY, op: fc.constantFrom("regex", "~~", "BETWEEN"), value: SCALAR }),
      // string op with non-string value
      fc.record({
        property: LABEL_KEY,
        op: fc.constantFrom("contains", "startsWith", "endsWith"),
        value: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null))
      }),
      // membership with non-array
      fc.record({ property: LABEL_KEY, op: fc.constantFrom("in", "notIn"), value: SCALAR }),
      // comparison with object value
      fc.record({ property: LABEL_KEY, op: fc.constant("eq"), value: fc.constant({}) }),
      // garbage shapes
      fc.constant("not-an-expression" as unknown),
      fc.constant({} as unknown)
    )
    fc.assert(
      fc.property(invalid, (expr) => {
        expect(() =>
          parseWhereExpression(expr as WhereExpression)
        ).toThrow(ValidationError)
      })
    )
  })
})
