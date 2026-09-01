import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeNestedJson } from "./normalizer.js";
import type { JsonObject, JsonValue } from "../domain/model.js";
import { isJsonArray, isPlainObject } from "../json/runtime.js";

const LABEL_KEY = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(s));

const SCALAR: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
);

/** Nested JSON with valid label-shaped keys and bounded depth. */
const nestedJson: fc.Arbitrary<JsonObject> = fc.letrec((tie) => {
  const value = fc.oneof(
    { depthSize: "small" },
    SCALAR,
    // SAFETY: fast-check letrec tie() returns the recursive object generator for nested JSON fixtures.
    tie("object") as fc.Arbitrary<JsonValue>,
    // SAFETY: fast-check array generators preserve the recursive object shape in property fixtures.
    fc.array(tie("object") as fc.Arbitrary<JsonObject>, { minLength: 1, maxLength: 3 }),
    fc.array(SCALAR, { minLength: 1, maxLength: 3 }),
    // SAFETY: fast-check array generators preserve mixed scalar/object fixture shapes.
    fc.array(fc.oneof(SCALAR, tie("object") as fc.Arbitrary<JsonObject>), {
      minLength: 1,
      maxLength: 3,
    }),
  );
  return {
    value,
    object: fc.dictionary(LABEL_KEY, value, { minKeys: 1, maxKeys: 4 }),
  };
}).object;

/**
 * Every object node the normalizer promotes becomes exactly one record:
 * nested objects and uniformly-object arrays spawn records, while mixed or
 * scalar arrays stay properties (mirroring normalizer semantics).
 */
const countObjectNodes = (value: JsonValue): number => {
  if (value === null) return 0;
  if (isJsonArray(value)) {
    const allObjects =
      value.length > 0 && value.every((element) => element !== null && isPlainObject(element));
    if (!allObjects) return 0;
    return value.reduce<number>((sum, element) => sum + countObjectNodes(element), 0);
  }
  if (isPlainObject(value)) {
    return (
      1 + Object.values(value).reduce<number>((sum, child) => sum + countObjectNodes(child), 0)
    );
  }
  return 0;
};

describe("nested JSON normalizer properties", () => {
  it("creates exactly one record per object node", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input);
        expect(result.records).toHaveLength(countObjectNodes(input));
      }),
    );
  });

  it("roots the import at local id 'root'", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input);
        expect(result.rootLocalId).toBe("root");
        expect(result.records[0]?.localId).toBe("root");
        expect(result.records[0]?.parentLocalId).toBeUndefined();
      }),
    );
  });

  it("assigns unique local ids with parents preceding children", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input);
        const seen = new Map<string, number>();
        result.records.forEach((record, index) => {
          expect(seen.has(record.localId)).toBe(false);
          seen.set(record.localId, index);
          if (record.parentLocalId !== undefined) {
            const parentIndex = seen.get(record.parentLocalId);
            expect(parentIndex).toBeDefined();
            expect(parentIndex!).toBeLessThan(index);
          }
        });
      }),
    );
  });

  it("keeps every scalar property on its owning record", () => {
    const walk = (value: JsonValue, localId: string, records: Map<string, JsonObject>): void => {
      if (value === null || !isPlainObject(value)) return;
      const data = records.get(localId);
      expect(data).toBeDefined();
      if (data === undefined) return;
      for (const [key, child] of Object.entries(value)) {
        if (child === null || (!isPlainObject(child) && !isJsonArray(child))) {
          expect(data[key]).toEqual(child);
        } else if (isJsonArray(child)) {
          const allObjects =
            child.length > 0 &&
            child.every((element) => element !== null && isPlainObject(element));
          if (!allObjects) expect(data[key]).toEqual(child);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (child !== null && isPlainObject(child)) {
          walk(child, `${localId}.${key}`, records);
        } else if (isJsonArray(child)) {
          const allObjects =
            child.length > 0 &&
            child.every((element) => element !== null && isPlainObject(element));
          if (allObjects) {
            child.forEach((element, index) => {
              walk(element, `${localId}.${key}.${index}`, records);
            });
          }
        }
      }
    };

    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input);
        const records = new Map<string, JsonObject>(result.records.map((r) => [r.localId, r.data]));
        walk(input, "root", records);
      }),
    );
  });

  it("derives valid labels from every nesting key that creates records", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const result = normalizeNestedJson(input);
        for (const record of result.records) {
          for (const label of record.labels) {
            expect(label).toMatch(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
          }
        }
      }),
    );
  });

  it("is deterministic for identical input", () => {
    fc.assert(
      fc.property(nestedJson, (input) => {
        const first = normalizeNestedJson(input);
        const second = normalizeNestedJson(input);
        expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
      }),
    );
  });
});
