import { ValidationError } from "../errors.js";
import type { JsonArray, JsonObject, JsonValue } from "../domain/model.js";

export interface UnparsedJsonObject {
  readonly [key: string]: UnparsedJsonValue;
}

export type UnparsedJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<UnparsedJsonValue>
  | UnparsedJsonObject;

export type RuntimeTagInput = UnparsedJsonValue | bigint | symbol | Uint8Array;

export const objectTag = (value: RuntimeTagInput): string => Object.prototype.toString.call(value);

export const isStringValue = (value: RuntimeTagInput): value is string =>
  objectTag(value) === "[object String]";

export const isNumberValue = (value: RuntimeTagInput): value is number =>
  objectTag(value) === "[object Number]" && Number.isFinite(value);

export const isBooleanValue = (value: RuntimeTagInput): value is boolean =>
  objectTag(value) === "[object Boolean]";

export const isPlainObject = (value: UnparsedJsonValue): value is JsonObject =>
  value !== null && !Array.isArray(value) && objectTag(value) === "[object Object]";

export const isJsonArray = (value: UnparsedJsonValue): value is ReadonlyArray<JsonValue> =>
  Array.isArray(value);

export const isJsonScalar = (value: JsonValue): boolean => {
  if (value === null) return true;
  if (Array.isArray(value)) return false;
  const tag = objectTag(value);
  return tag === "[object String]" || tag === "[object Number]" || tag === "[object Boolean]";
};

export const allJsonObjects = (
  values: ReadonlyArray<JsonValue>,
): values is ReadonlyArray<JsonObject> =>
  values.every((entry) => entry !== null && !Array.isArray(entry) && isPlainObject(entry));

export const parseJsonObject = (value: UnparsedJsonValue, message: string): JsonObject => {
  if (!isPlainObject(value)) {
    throw new ValidationError({ message });
  }
  // SAFETY: plain-object checks after JSON.parse guarantee JSON-serializable trees.
  return value;
};

export const parseJsonValue = (value: UnparsedJsonValue, message: string): JsonValue => {
  if (
    value === null ||
    isStringValue(value) ||
    isNumberValue(value) ||
    isBooleanValue(value) ||
    isJsonArray(value)
  ) {
    if (isJsonArray(value)) {
      // SAFETY: recursive parseJsonValue validates each array element as JsonValue.
      return value.map((entry) => parseJsonValue(entry, message)) as JsonArray;
    }
    return value;
  }
  if (isPlainObject(value)) {
    return parseJsonObject(value, message);
  }
  throw new ValidationError({ message });
};

export const parseFiniteNumber = (value: UnparsedJsonValue, message: string): number => {
  if (!isNumberValue(value)) {
    throw new ValidationError({ message });
  }
  return value;
};

export const parseOptionalFiniteNumber = (
  value: UnparsedJsonValue,
  message: string,
): number | undefined => {
  if (value === undefined) return undefined;
  return parseFiniteNumber(value, message);
};
