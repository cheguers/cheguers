import { ValidationError } from "../errors.js"
import { isLabelName } from "../domain/ids.js"
import type {
  JsonArray,
  JsonObject,
  JsonValue
} from "../domain/model.js"

export interface ImportRecordSpec {
  readonly localId: string
  readonly data: JsonObject
  readonly labels: ReadonlyArray<string>
  readonly parentLocalId: string | undefined
  readonly relationshipType: string | undefined
}

export interface NormalizedImport {
  readonly rootLocalId: string
  readonly records: ReadonlyArray<ImportRecordSpec>
}

const labelForKey = (key: string, path: string): string => {
  if (!isLabelName(key)) {
    throw new ValidationError({
      message: `cannot derive a valid label/type from nesting key ${JSON.stringify(key)} at ${path}`
    })
  }
  return key
}

const isScalar = (value: JsonValue): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"

const allObjects = (values: ReadonlyArray<JsonValue>): values is ReadonlyArray<JsonObject> =>
  values.every(
    (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  )

export const normalizeNestedJson = (
  input: JsonObject,
  options?: { readonly rootLabels?: ReadonlyArray<string> }
): NormalizedImport => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError({
      message: "import input must be a plain JSON object"
    })
  }
  if (options?.rootLabels !== undefined) {
    for (const label of options.rootLabels) {
      if (!isLabelName(label)) {
        throw new ValidationError({ message: `invalid import label: ${JSON.stringify(label)}` })
      }
    }
  }

  const specs: Array<ImportRecordSpec> = []

  interface DeferredChild {
    readonly value: JsonObject
    readonly localId: string
    readonly parentLocalId: string
    readonly relationshipType: string
    readonly label: string
  }

  const walkObject = (
    value: JsonObject,
    localId: string,
    parentLocalId: string | undefined,
    viaType: string | undefined,
    extraLabels: ReadonlyArray<string>
  ): void => {
    const data: Record<string, JsonValue> = {}
    const children: Array<DeferredChild> = []

    for (const [key, child] of Object.entries(value)) {
      const path = `${localId}.${key}`
      if (child === null || isScalar(child)) {
        data[key] = child
        continue
      }
      if (Array.isArray(child)) {
        const arr = child as JsonArray
        if (arr.length > 0 && allObjects(arr)) {
          const childLabel = labelForKey(key, path)
          arr.forEach((element, index) => {
            children.push({
              value: element as JsonObject,
              localId: `${localId}.${key}.${index}`,
              parentLocalId: localId,
              relationshipType: childLabel,
              label: childLabel
            })
          })
          continue
        }
        data[key] = child
        continue
      }
      const childLabel = labelForKey(key, path)
      children.push({
        value: child as JsonObject,
        localId: `${localId}.${key}`,
        parentLocalId: localId,
        relationshipType: childLabel,
        label: childLabel
      })
    }

    specs.push({
      localId,
      data: Object.freeze(data),
      labels: [...new Set([...extraLabels].sort())],
      parentLocalId,
      relationshipType: viaType
    })

    for (const child of children) {
      walkObject(child.value, child.localId, child.parentLocalId, child.relationshipType, [child.label])
    }
  }

  walkObject(input, "root", undefined, undefined, options?.rootLabels ?? [])
  return { rootLocalId: "root", records: Object.freeze(specs) }
}
