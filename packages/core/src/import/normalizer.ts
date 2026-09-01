import { ValidationError } from "../errors.js";
import { isLabelName } from "../domain/ids.js";
import type { JsonObject, JsonValue } from "../domain/model.js";
import { allJsonObjects, isJsonScalar, isPlainObject } from "../json/runtime.js";

export interface ImportRecordSpec {
  readonly localId: string;
  readonly data: JsonObject;
  readonly labels: ReadonlyArray<string>;
  readonly parentLocalId: string | undefined;
  readonly relationshipType: string | undefined;
}

export interface NormalizedImport {
  readonly rootLocalId: string;
  readonly records: ReadonlyArray<ImportRecordSpec>;
}

const labelForKey = (key: string, path: string): string => {
  if (!isLabelName(key)) {
    throw new ValidationError({
      message: `cannot derive a valid label/type from nesting key ${JSON.stringify(key)} at ${path}`,
    });
  }
  return key;
};

export const normalizeNestedJson = (
  input: JsonObject,
  options?: { readonly rootLabels?: ReadonlyArray<string> },
): NormalizedImport => {
  if (options?.rootLabels !== undefined) {
    for (const label of options.rootLabels) {
      if (!isLabelName(label)) {
        throw new ValidationError({ message: `invalid import label: ${JSON.stringify(label)}` });
      }
    }
  }

  const specs: Array<ImportRecordSpec> = [];

  interface DeferredChild {
    readonly value: JsonObject;
    readonly localId: string;
    readonly parentLocalId: string;
    readonly relationshipType: string;
    readonly label: string;
  }

  const walkObject = (
    value: JsonObject,
    localId: string,
    parentLocalId: string | undefined,
    viaType: string | undefined,
    extraLabels: ReadonlyArray<string>,
  ): void => {
    const data: Record<string, JsonValue> = {};
    const children: Array<DeferredChild> = [];

    for (const [key, child] of Object.entries(value)) {
      const path = `${localId}.${key}`;
      if (child === null || isJsonScalar(child)) {
        data[key] = child;
        continue;
      }
      if (Array.isArray(child)) {
        if (child.length > 0 && allJsonObjects(child)) {
          const childLabel = labelForKey(key, path);
          child.forEach((element, index) => {
            children.push({
              value: element,
              localId: `${localId}.${key}.${index}`,
              parentLocalId: localId,
              relationshipType: childLabel,
              label: childLabel,
            });
          });
          continue;
        }
        data[key] = child;
        continue;
      }
      if (!isPlainObject(child)) {
        data[key] = child;
        continue;
      }
      const childLabel = labelForKey(key, path);
      children.push({
        value: child,
        localId: `${localId}.${key}`,
        parentLocalId: localId,
        relationshipType: childLabel,
        label: childLabel,
      });
    }

    specs.push({
      localId,
      data: Object.freeze(data),
      labels: [...new Set([...extraLabels].sort())],
      parentLocalId,
      relationshipType: viaType,
    });

    for (const child of children) {
      walkObject(child.value, child.localId, child.parentLocalId, child.relationshipType, [
        child.label,
      ]);
    }
  };

  walkObject(input, "root", undefined, undefined, options?.rootLabels ?? []);
  return { rootLocalId: "root", records: Object.freeze(specs) };
};
