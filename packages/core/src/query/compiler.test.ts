import { describe, expect, it } from "vitest"
import { parseRecordQuery } from "./parser.js"
import { compileRecordQueryAst } from "./compiler/index.js"
import { Effect, Exit } from "effect"
import type { RecordQuery } from "./types.js"

const parse = async (query: RecordQuery) =>
  await Effect.runPromise(parseRecordQuery(query))

describe("query parser", () => {
  it("normalizes label order and dedupes", async () => {
    const ast = await parse({ labels: ["zeta", "alpha", "zeta"] })
    expect(ast.labels).toEqual(["alpha", "zeta"])
  })

  it("rejects unknown operators before compilation", async () => {
    const exit = await Effect.runPromiseExit(
      parseRecordQuery({
        where: { property: "x", op: "regex" as never, value: "y" }
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("rejects invalid related hops", async () => {
    const exit = await Effect.runPromiseExit(
      parseRecordQuery({
        where: {
          related: {
            type: "knows",
            direction: "outgoing",
            maxHops: 4
          }
        }
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("rejects non-scalar comparison values", async () => {
    const exit = await Effect.runPromiseExit(
      parseRecordQuery({
        where: { property: "meta", op: "eq", value: { nested: true } as never }
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("compiler golden tests", () => {
  it("compiles id filter to parameterized equality", async () => {
    const ast = await parse({ id: "rec_golden_000001" })
    const compiled = compileRecordQueryAst(ast)
    expect(compiled.sql).toContain("r.public_id = ?")
    expect(compiled.params).toEqual(["rec_golden_000001"])
  })

  it("compiles labels to indexed EXISTS with stable ordering", async () => {
    const ast = await parse({ labels: ["person", "admin"] })
    const compiled = compileRecordQueryAst(ast)
    expect(compiled.sql.match(/EXISTS\(SELECT 1 FROM record_labels/g)?.length).toEqual(2)
    expect(compiled.params).toEqual(["admin", "person"])
  })

  it("golden: property eq produces exact sql and param order", async () => {
    const ast = await parse({
      labels: ["person"],
      where: { and: [{ property: "age", op: "gte", value: 18 }, { property: "name", op: "eq", value: "alice" }] },
      orderBy: [{ property: "age", direction: "desc" }],
      limit: 10,
      offset: 5
    })
    const compiled = compileRecordQueryAst(ast)
    // children sorted canonically: age gte before name eq
    expect(compiled.params).toEqual([
      "person",
      '$."age"',
      18,
      '$."name"',
      "alice",
      '$."age"',
      10,
      5
    ])
    expect(compiled.sql).toBe(
      'SELECT r.id, r.public_id, r.data, r.created_at, r.updated_at FROM records r WHERE EXISTS(SELECT 1 FROM record_labels rl_q JOIN labels l_q ON l_q.id = rl_q.label_id WHERE rl_q.record_id = r.id AND l_q.name = ?) AND (json_extract(r.data, ?) >= ? AND json_extract(r.data, ?) = ?) ORDER BY json_extract(r.data, ?) DESC, r.public_id ASC LIMIT ? OFFSET ?'
    )
  })

  it("golden: offset without limit uses -1 sentinel", async () => {
    const ast = await parse({ offset: 5 })
    const compiled = compileRecordQueryAst(ast)
    expect(compiled.sql.endsWith("LIMIT ? OFFSET ?")).toBe(true)
    expect(compiled.params).toEqual([-1, 5])
  })

  it("golden: equivalent ASTs produce identical SQL regardless of child input order", async () => {
    const a = await parse({
      where: { and: [{ property: "a", op: "eq", value: 1 }, { property: "b", op: "eq", value: 2 }] }
    })
    const b = await parse({
      where: { and: [{ property: "b", op: "eq", value: 2 }, { property: "a", op: "eq", value: 1 }] }
    })
    expect(compileRecordQueryAst(a).sql).toEqual(compileRecordQueryAst(b).sql)
    expect(compileRecordQueryAst(a).params).toEqual(compileRecordQueryAst(b).params)
  })

  it("golden: not/or compile with nested parens", async () => {
    const ast = await parse({
      where: {
        or: [
          { property: "role", op: "eq", value: "admin" },
          { not: { property: "banned", op: "eq", value: true } }
        ]
      }
    })
    const compiled = compileRecordQueryAst(ast)
    // canonical child ordering places the "not" node before "property" nodes
    expect(compiled.sql).toContain("((NOT json_extract(r.data, ?) = ?) OR json_extract(r.data, ?) = ?)")
    expect(compiled.params).toEqual(['$."banned"', true, '$."role"', "admin"])
  })

  it("golden: string operators use LIKE with escaped patterns", async () => {
    const ast = await parse({ where: { property: "title", op: "startsWith", value: "50%_off" } })
    const compiled = compileRecordQueryAst(ast)
    expect(compiled.sql).toContain("CAST(json_extract(r.data, ?) AS TEXT) LIKE ? ESCAPE '\\'")
    expect(compiled.params[1]).toEqual("50\\%\\_off%")
  })

  it("golden: membership with empty list short-circuits", async () => {
    const inAst = await parse({ where: { property: "tag", op: "in", value: [] } })
    expect(compileRecordQueryAst(inAst).sql).toContain("0 = 1")
    const notInAst = await parse({ where: { property: "tag", op: "notIn", value: [] } })
    expect(compileRecordQueryAst(notInAst).sql).toContain("1 = 1")
  })

  it("golden: exists compiles to null checks", async () => {
    const ast = await parse({ where: { property: "email", op: "exists" } })
    expect(compileRecordQueryAst(ast).sql).toContain("json_extract(r.data, ?) IS NOT NULL")
    const negated = await parse({ where: { property: "email", op: "exists", value: false } })
    expect(compileRecordQueryAst(negated).sql).toContain("json_extract(r.data, ?) IS NULL")
  })

  it("golden: one-hop related predicate compiles to indexed EXISTS", async () => {
    const ast = await parse({
      where: {
        related: {
          type: "knows",
          direction: "outgoing",
          where: { property: "city", op: "eq", value: "berlin" }
        }
      }
    })
    const compiled = compileRecordQueryAst(ast)
    expect(compiled.sql).toContain(
      "EXISTS(SELECT 1 FROM relationships r0_h1 WHERE r0_h1.source_id = r.id AND r0_h1.type = ? AND EXISTS(SELECT 1 FROM records fin_0 WHERE fin_0.id = r0_h1.target_id AND (json_extract(fin_0.data, ?) = ?)))"
    )
    expect(compiled.params).toEqual(["knows", '$."city"', "berlin"])
  })

  it("golden: two-hop incoming related predicate chains hops", async () => {
    const ast = await parse({
      where: {
        related: { type: "authored", direction: "incoming", maxHops: 2 }
      }
    })
    const compiled = compileRecordQueryAst(ast)
    // minHops defaults to 1, so depths [1, 2] compile as an OR of chains
    expect(compiled.sql).toContain(
      "EXISTS(SELECT 1 FROM relationships r0_h1 WHERE r0_h1.target_id = r.id AND r0_h1.type = ?) OR EXISTS(SELECT 1 FROM relationships r0_h1 JOIN relationships r0_h2 ON r0_h2.target_id = r0_h1.source_id WHERE r0_h1.target_id = r.id AND r0_h1.type = ? AND r0_h2.type = ?)"
    )
    expect(compiled.params).toEqual(["authored", "authored", "authored"])
  })
})
