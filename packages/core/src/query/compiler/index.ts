import type {
  ComparisonOperator,
  FilterAst,
  OrderAst,
  RecordQueryAst
} from "../ast.js"
import { jsonPathParam, compileLikePattern } from "./util.js"

type Param = string | number | boolean | null

export interface CompiledWhere {
  readonly sql: string
  readonly params: ReadonlyArray<Param>
}

const comparisonSql: Record<ComparisonOperator, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<="
}

/**
 * Compiles a filter AST into a parameterized SQL fragment evaluated against
 * the record row identified by `ctx.alias`.
 *
 * Invariants:
 * - every user value becomes a parameter;
 * - equivalent ASTs produce identical SQL and parameter ordering
 *   (children are canonically sorted by the parser);
 * - related-record predicates compile to indexed EXISTS chains over the
 *   canonical edge table.
 */
export const compileFilter = (
  node: FilterAst,
  ctx: { readonly alias: string },
  depthCounter: { readonly count: number } = { count: 0 }
): CompiledWhere => {
  const params: Array<Param> = []
  const alias = ctx.alias

  const propertySql = (_property: string): string =>
    `json_extract(${alias}.data, ?)`

  switch (node.kind) {
    case "property": {
      const path = jsonPathParam(node.property)
      if (node.op === "exists") {
        params.push(path)
        return {
          sql:
            node.value === false
              ? `${propertySql(node.property)} IS NULL`
              : `${propertySql(node.property)} IS NOT NULL`,
          params
        }
      }
      if (node.op === "in" || node.op === "notIn") {
        params.push(path)
        const values = node.value as ReadonlyArray<Param>
        if (values.length === 0) {
          return {
            sql: node.op === "in" ? "0 = 1" : "1 = 1",
            params
          }
        }
        for (const v of values) params.push(v)
        const placeholders = values.map(() => "?").join(", ")
        const sql =
          node.op === "in"
            ? `${propertySql(node.property)} IN (${placeholders})`
            : `${propertySql(node.property)} NOT IN (${placeholders})`
        return { sql, params }
      }
      if (
        node.op === "contains" ||
        node.op === "startsWith" ||
        node.op === "endsWith"
      ) {
        params.push(path)
        params.push(compileLikePattern(node.value as string, node.op))
        // ESCAPE '\' and the doubled backslash inside the literal pattern
        return {
          sql: `CAST(${propertySql(node.property)} AS TEXT) LIKE ? ESCAPE '\\'`,
          params
        }
      }
      params.push(path)
      if (node.value === null && node.op === "eq") {
        return { sql: `${propertySql(node.property)} IS NULL`, params }
      }
      if (node.value === null && node.op === "neq") {
        return { sql: `${propertySql(node.property)} IS NOT NULL`, params }
      }
      params.push(node.value as Param)
      return {
        sql: `${propertySql(node.property)} ${comparisonSql[node.op]} ?`,
        params
      }
    }

    case "related":
      return compileRelated(node, ctx, depthCounter.count)

    case "and":
    case "or": {
      const parts = node.children.map((child) => {
        const compiled = compileFilter(child, ctx, depthCounter)
        params.push(...compiled.params)
        return compiled.sql
      })
      return { sql: `(${parts.join(node.kind === "and" ? " AND " : " OR ")})`, params }
    }

    case "not": {
      const compiled = compileFilter(node.child, ctx, depthCounter)
      params.push(...compiled.params)
      return { sql: `(NOT ${compiled.sql})`, params }
    }
  }
}

interface RelatedChainHopContext {
  readonly hopAliasPrefix: string
}

const compileRelatedChain = (
  hops: number,
  type: string,
  direction: "outgoing" | "incoming",
  finalRecordAlias: string | undefined,
  whereSql: string | undefined,
  whereParams: ReadonlyArray<Param>,
  ctx: { readonly alias: string },
  hopCtx: RelatedChainHopContext
): CompiledWhere => {
  const params: Array<Param> = []
  const fwdColumn =
    direction === "incoming" ? "target_id" : "source_id"
  const nextColumn =
    direction === "incoming" ? "source_id" : "target_id"
  const p = hopCtx.hopAliasPrefix

  // All hops live in a single SELECT scope via JOINs so every column
  // reference resolves without multi-level correlation.
  let inner = `SELECT 1 FROM relationships ${p}h1`
  for (let i = 2; i <= hops; i++) {
    inner += ` JOIN relationships ${p}h${i} ON ${p}h${i}.${fwdColumn} = ${p}h${i - 1}.${nextColumn}`
  }
  inner += ` WHERE ${p}h1.${fwdColumn} = ${ctx.alias}.id`
  for (let i = 1; i <= hops; i++) {
    inner += ` AND ${p}h${i}.type = ?`
    params.push(type)
  }
  if (whereSql !== undefined && finalRecordAlias !== undefined) {
    inner += ` AND EXISTS(SELECT 1 FROM records ${finalRecordAlias} WHERE ${finalRecordAlias}.id = ${p}h${hops}.${nextColumn} AND (${whereSql}))`
    params.push(...whereParams)
  }
  return { sql: `EXISTS(${inner})`, params }
}

const compileRelated = (
  node: Extract<FilterAst, { kind: "related" }>,
  ctx: { readonly alias: string },
  depth: number
): CompiledWhere => {
  const rel = node.related
  const depths: number[] = []
  for (let d = rel.minHops; d <= Math.max(rel.maxHops, rel.minHops); d++) {
    depths.push(d)
  }

  const uniqueSuffix = `${depth}`
  const depthCounter = { count: depth + 1 }
  const hopPrefix = `r${uniqueSuffix}_`
  const finalAlias = `fin_${uniqueSuffix}`

  const compileDirection = (
    direction: "outgoing" | "incoming"
  ): CompiledWhere => {
    const localParams: Array<Param> = []
    let whereCompiled: CompiledWhere | undefined
    if (rel.where !== undefined) {
      whereCompiled = compileFilter(rel.where, { alias: finalAlias }, depthCounter)
    }
    const parts = depths.map((hops) => {
      const compiled = compileRelatedChain(
        hops,
        rel.type,
        direction,
        rel.where === undefined ? undefined : finalAlias,
        whereCompiled?.sql,
        whereCompiled?.params ?? [],
        ctx,
        { hopAliasPrefix: hopPrefix }
      )
      localParams.push(...compiled.params)
      return compiled.sql
    })
    if (parts.length === 1) return { sql: parts[0]!, params: localParams }
    return { sql: `(${parts.join(" OR ")})`, params: localParams }
  }

  return compileDirection(rel.direction)
}

export interface CompiledQuery {
  readonly sql: string
  readonly params: ReadonlyArray<Param>
}

export const compileRecordQueryAst = (ast: RecordQueryAst): CompiledQuery => {
  const params: Array<Param> = []
  const conditions: Array<string> = []

  if (ast.id !== undefined) {
    conditions.push("r.public_id = ?")
    params.push(ast.id)
  }

  for (const label of ast.labels) {
    conditions.push(
      `EXISTS(SELECT 1 FROM record_labels rl_q JOIN labels l_q ON l_q.id = rl_q.label_id WHERE rl_q.record_id = r.id AND l_q.name = ?)`
    )
    params.push(label)
  }

  if (ast.where !== undefined) {
    const compiled = compileFilter(ast.where, { alias: "r" }, { count: 0 })
    conditions.push(compiled.sql)
    params.push(...compiled.params)
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const orderByParts: Array<string> = ast.orderBy.map((o: OrderAst) => {
    params.push(jsonPathParam(o.property))
    return `json_extract(r.data, ?) ${o.direction.toUpperCase()}`
  })
  orderByParts.push("r.public_id ASC")

  const hasWindowing = ast.limit !== undefined || ast.offset !== undefined
  const limitSql = hasWindowing ? " LIMIT ? OFFSET ?" : ""
  if (hasWindowing) {
    params.push(ast.limit ?? -1)
    params.push(ast.offset ?? 0)
  }

  const sql = `SELECT r.id, r.public_id, r.data, r.created_at, r.updated_at FROM records r ${whereSql} ORDER BY ${orderByParts.join(", ")}${limitSql}`
  return { sql, params }
}
