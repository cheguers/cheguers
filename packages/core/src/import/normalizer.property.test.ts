import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { normalizeNestedJson } from "./normalizer.js"
import type { JsonValue } from "../domain/model.js"

const LABEL_KEY = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(s))

const SCALAR: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null)
)

/** Nested JSON with valid label-shaped keys and bounded depth. */
const nestedJson = fc
  .letrec((tie) => {
    const value: fc.Arbitrary<JsonValue> = fc.oneof(
      { depthSize: "small" },
      SCALAR,
      tie("object") as fc.Arbitrary<JsonValue>,
      fc.array(tie("object") as fc.Arbitrary<JsonValue>, {
        minLength: 1,
        maxLength: 3
      }) as unknown as fc.Arbitrary<JsonValue>,
      fc.array(SCALAR, { minLength: 1, maxLength: 3 }) as unknown as fc.Arbitrary<JsonValue>,
      fc.array(
        fc.oneof(SCALAR, tie("object") as fc.Arbitrary<JsonValue>),
        { minLength: 1, maxLength: 3 }
      ) as unknown as fc.Arbitrary<JsonValue>
    )
    return {
      value,
      object: fc.dictionary(LABEL_KEY, value, { minKeys: 1, maxKeys: 4 })
    }
  })
  .object

/**
 * Every object node the normalizer promotes becomes exactly one record:
 * nested objects and uniformly-object arrays spawn records, while mixed or
 * scalar arrays stay properties (mirroring normalizer semantics).
 */
const countObjectNodes = (value: JsonValue): number => {
  if (value === null || typeof value !== "object") return 0
  if (Array.isArray(value)) {
    const arr = value as JsonValue[]
    const allObjects =
      arr.length > 0 &&
      arr.every(
        (element) =>
          element !== null && typeof element === "object" && !Array.isArray(element)
      )
    if (!allObjects) return 0
    return arr.reduce<number>((sum, element) => sum + countObjectNodes(element), 0)
  }
  return (
    1 +
    Object.values(value as Record<string, JsonValue>).reduce<number>(
      (sum, child) => sum + countObjectNodes(child),
      0
    )
  )
}

describe("nested JSON normalizer properties", () => {
  it("creates exactly one record per object node", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input)
        expect(result.records).toHaveLength(countObjectNodes(input))
      })
    )
  })

  it("roots the import at local id 'root'", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input)
        expect(result.rootLocalId).toBe("root")
        expect(result.records[0]?.localId).toBe("root")
        expect(result.records[0]?.parentLocalId).toBeUndefined()
      })
    )
  })

  it("assigns unique local ids with parents preceding children", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input)
        const seen = new Map<string, number>()
        result.records.forEach((record, index) => {
          expect(seen.has(record.localId)).toBe(false)
          seen.set(record.localId, index)
          if (record.parentLocalId !== undefined) {
            const parentIndex = seen.get(record.parentLocalId)
            expect(parentIndex).toBeDefined()
            expect(parentIndex!).toBeLessThan(index)
          }
        })
      })
    )
  })

  it("keeps every scalar property on its owning record", () => {
    const walk = (value: unknown, localId: string, records: Map<string, Record<string, JsonValue>>): void => {
      if (value === null || typeof value !== "object") return
      const data = records.get(localId)
      expect(data).toBeDefined()
      if (data === undefined) return
      for (const [key, child] of Object.entries(value as Record<string, JsonValue>)) {
        if (child === null || typeof child !== "object") {
          expect(data[key]).toEqual(child)
        } else if (Array.isArray(child)) {
          const allObjects =
            child.length > 0 &&
            (child as JsonValue[]).every(
              (e) => e !== null && typeof e === "object" && !Array.isArray(e)
            )
          if (!allObjects) expect(data[key]).toEqual(child)
        }
      }
      for (const [key, child] of Object.entries(value as Record<string, JsonValue>)) {
        if (child !== null && typeof child === "object") {
          if (Array.isArray(child)) {
            const allObjects =
              child.length > 0 &&
              (child as JsonValue[]).every(
                (e) => e !== null && typeof e === "object" && !Array.isArray(e)
              )
            if (allObjects) {
              child.forEach((element, index) => {
                walk(element, `${localId}.${key}.${index}`, records)
              })
            }
          } else {
            walk(child, `${localId}.${key}`, records)
          }
        }
      }
    }

    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input)
        const records = new Map<string, Record<string, JsonValue>>(
          result.records.map((r) => [r.localId, r.data as Record<string, JsonValue>])
        )
        walk(input, "root", records)
      })
    )
  })

  it("derives valid labels from every nesting key that creates records", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input)
        for (const record of result.records) {
          for (const label of record.labels) {
            expect(label).toMatch(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/)
          }
        }
      })
    )
  })

  it("is deterministic for identical input", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const first = normalizeNestedJson(input)
        const second = normalizeNestedJson(input)
        expect(JSON.stringify(first)).toEqual(JSON.stringify(second))
      })
    )
  })
})
