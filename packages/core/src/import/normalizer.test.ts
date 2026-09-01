import { describe, expect, it } from "vitest"
import { normalizeNestedJson } from "./normalizer.js"
import { ValidationError } from "../errors.js"

describe("normalizeNestedJson", () => {
  it("keeps scalars and scalar arrays as properties of the root record", () => {
    const plan = normalizeNestedJson(
      { name: "alice", age: 30, tags: ["a", "b"], admin: true, note: null },
      { rootLabels: ["person"] }
    )
    expect(plan.records).toHaveLength(1)
    const [root] = plan.records
    expect(root?.localId).toBe("root")
    expect(root?.data).toEqual({
      name: "alice",
      age: 30,
      tags: ["a", "b"],
      admin: true,
      note: null
    })
    expect(root?.labels).toEqual(["person"])
  })

  it("turns nested objects into child records with derived labels/types", () => {
    const plan = normalizeNestedJson({
      name: "alice",
      address: { street: "main", zip: "1234" }
    })
    expect(plan.records.map((r) => r.localId)).toEqual(["root", "root.address"])
    const child = plan.records[1]!
    expect(child.data).toEqual({ street: "main", zip: "1234" })
    expect(child.labels).toEqual(["address"])
    expect(child.parentLocalId).toBe("root")
    expect(child.relationshipType).toBe("address")
  })

  it("turns arrays of objects into multiple child records", () => {
    const plan = normalizeNestedJson({
      title: "post",
      comments: [{ body: "first" }, { body: "second" }]
    })
    expect(plan.records.map((r) => r.localId)).toEqual([
      "root",
      "root.comments.0",
      "root.comments.1"
    ])
    for (const localId of ["root.comments.0", "root.comments.1"]) {
      const spec = plan.records.find((r) => r.localId === localId)!
      expect(spec.labels).toEqual(["comments"])
      expect(spec.relationshipType).toBe("comments")
      expect(spec.parentLocalId).toBe("root")
    }
  })

  it("recurses into nested children", () => {
    const plan = normalizeNestedJson({
      author: { name: "z", profile: { bio: "hi" } }
    })
    expect(plan.records.map((r) => r.localId)).toEqual([
      "root",
      "root.author",
      "root.author.profile"
    ])
    expect(plan.records[2]?.parentLocalId).toBe("root.author")
    expect(plan.records[2]?.relationshipType).toBe("profile")
  })

  it("keeps mixed or scalar arrays as properties", () => {
    const plan = normalizeNestedJson({
      mixed: [{}, 1],
      empty: []
    })
    expect(plan.records).toHaveLength(1)
    expect(plan.records[0]!.data.mixed).toEqual([{}, 1])
    expect(plan.records[0]!.data.empty).toEqual([])
  })

  it("throws ValidationError for unusable nesting keys", () => {
    try {
      normalizeNestedJson({ "bad key!": { a: 1 } })
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
    }
  })

  it("merges duplicate labels deterministically", () => {
    const plan = normalizeNestedJson({ items: [{ n: 1 }, { n: 2 }] }, { rootLabels: ["items"] })
    expect(plan.records[0]?.labels).toEqual(["items"])
    expect(plan.records[1]?.labels).toEqual(["items"])
  })
})
