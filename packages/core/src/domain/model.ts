import type { LabelName, RecordId, RelationshipId, RelationshipType } from "./ids.js";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = ReadonlyArray<JsonValue>;
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export interface CheguersRecord {
  readonly id: RecordId;
  readonly data: JsonObject;
  readonly labels: ReadonlyArray<LabelName>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheguersRelationship {
  readonly id: RelationshipId;
  readonly type: RelationshipType;
  readonly sourceId: RecordId;
  readonly targetId: RecordId;
  readonly properties: JsonObject;
  readonly createdAt: string;
}

export interface CreateRecordInput {
  readonly id?: string;
  readonly data: JsonObject;
  readonly labels?: ReadonlyArray<string>;
}

export interface UpdateRecordInput {
  readonly data?: JsonObject;
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
}

export interface CreateRelationshipInput {
  readonly id?: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly properties?: JsonObject;
}

export type VectorMetric = "cosine" | "l2";

export interface UpsertVectorInput {
  readonly recordId: string;
  readonly namespace?: string;
  readonly vector: ReadonlyArray<number>;
}

export interface DeleteVectorInput {
  readonly recordId: string;
  readonly namespace?: string;
}

export interface CheguersVectorMeta {
  readonly recordId: RecordId;
  readonly namespace: string;
  readonly dimensions: number;
  readonly updatedAt: string;
}

export interface VectorSearchHit {
  readonly record: CheguersRecord;
  readonly distance: number;
}
