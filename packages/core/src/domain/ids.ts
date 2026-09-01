import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

export type RecordId = string & { readonly [brand]: "RecordId" };
export type RelationshipId = string & { readonly [brand]: "RelationshipId" };

export const asRecordId = (value: string): RecordId => {
  if (!isRecordId(value)) {
    throw new RangeError(`invalid record id: ${value}`);
  }
  return value;
};

export const asRelationshipId = (value: string): RelationshipId => {
  if (!isRelationshipId(value)) {
    throw new RangeError(`invalid relationship id: ${value}`);
  }
  return value;
};

export const generateRecordId = (): RecordId => {
  const id = `rec_${randomUUID().replace(/-/g, "")}`;
  // SAFETY: rec_ prefix plus 32 hex chars always satisfies ID_PATTERN.
  return id as RecordId;
};

export const generateRelationshipId = (): RelationshipId => {
  const id = `rel_${randomUUID().replace(/-/g, "")}`;
  // SAFETY: rel_ prefix plus 32 hex chars always satisfies ID_PATTERN.
  return id as RelationshipId;
};

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{7,127}$/;

export const isRecordId = (value: string): value is RecordId => ID_PATTERN.test(value);

export const isRelationshipId = (value: string): value is RelationshipId => ID_PATTERN.test(value);

export type LabelName = string & { readonly [brand]: "LabelName" };

const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export const isLabelName = (value: string): value is LabelName => LABEL_PATTERN.test(value);

export type RelationshipType = string & { readonly [brand]: "RelationshipType" };

const REL_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export const isRelationshipType = (value: string): value is RelationshipType =>
  REL_TYPE_PATTERN.test(value);
