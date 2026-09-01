import { ValidationError } from "../errors.js";
import {
  asRecordId,
  asRelationshipId,
  isLabelName,
  isRecordId,
  isRelationshipId,
  isRelationshipType,
  type LabelName,
  type RecordId,
  type RelationshipId,
  type RelationshipType,
} from "../domain/ids.js";
import type { CheguersRecord, CheguersRelationship, JsonObject } from "../domain/model.js";
import { parseJsonObject, objectTag } from "../json/runtime.js";
import type { SqlExecutor, SqlRow, SqlValue } from "./sql.js";

/** Raw row object returned by the Turso driver before column parsing. */
export interface TursoRowPayload {
  readonly [column: string]: SqlValue | undefined;
}

export const sqlRowsFrom = (
  promise: Promise<ReadonlyArray<unknown>>,
): Promise<ReadonlyArray<SqlRow>> =>
  promise.then((rows) => {
    // SAFETY: Turso returns plain objects whose keys match our SELECT column lists.
    return rows as ReadonlyArray<SqlRow>;
  });

export const sqlRowFrom = (row: TursoRowPayload): SqlRow => {
  // SAFETY: executor boundaries only pass driver rows into SqlRow accessors.
  return row as SqlRow;
};

const isSqlString = (value: SqlValue | undefined): value is string =>
  value !== undefined && value !== null && objectTag(value) === "[object String]";

const isSqlNumber = (value: SqlValue | undefined): value is number =>
  value !== undefined && objectTag(value) === "[object Number]" && Number.isFinite(value);

const requireString = (value: SqlValue | undefined, column: string): string => {
  if (!isSqlString(value)) {
    throw new ValidationError({ message: `expected string column ${column}` });
  }
  return value;
};

const requireNumber = (value: SqlValue | undefined, column: string): number => {
  if (!isSqlNumber(value)) {
    throw new ValidationError({ message: `expected numeric column ${column}` });
  }
  return value;
};

export const readStringColumn = (row: SqlRow, column: string): string =>
  requireString(row[column], column);

export const readNumberColumn = (row: SqlRow, column: string): number =>
  requireNumber(row[column], column);

export const readJsonObjectColumn = (row: SqlRow, column: string): JsonObject =>
  parseJsonObject(JSON.parse(readStringColumn(row, column)), `invalid JSON in column ${column}`);

export const readRecordIdColumn = (row: SqlRow, column: string): RecordId => {
  const value = readStringColumn(row, column);
  if (!isRecordId(value)) {
    throw new ValidationError({ message: `invalid record id in column ${column}` });
  }
  return asRecordId(value);
};

export const readRelationshipIdColumn = (row: SqlRow, column: string): RelationshipId => {
  const value = readStringColumn(row, column);
  if (!isRelationshipId(value)) {
    throw new ValidationError({ message: `invalid relationship id in column ${column}` });
  }
  return asRelationshipId(value);
};

export const readRelationshipTypeColumn = (row: SqlRow, column: string): RelationshipType => {
  const value = readStringColumn(row, column);
  if (!isRelationshipType(value)) {
    throw new ValidationError({ message: `invalid relationship type in column ${column}` });
  }
  return value;
};

export const readLabelNameColumn = (row: SqlRow, column: string): LabelName => {
  const value = readStringColumn(row, column);
  if (!isLabelName(value)) {
    throw new ValidationError({ message: `invalid label in column ${column}` });
  }
  return value;
};

export interface RecordKey {
  readonly numericId: number;
  readonly publicId: string;
}

export const recordKeyFromRow = (row: SqlRow): RecordKey => ({
  numericId: readNumberColumn(row, "id"),
  publicId: readStringColumn(row, "public_id"),
});

export const parseRelationshipRow = (row: SqlRow): CheguersRelationship => ({
  id: readRelationshipIdColumn(row, "public_id"),
  type: readRelationshipTypeColumn(row, "type"),
  sourceId: readRecordIdColumn(row, "source_public_id"),
  targetId: readRecordIdColumn(row, "target_public_id"),
  properties: readJsonObjectColumn(row, "properties"),
  createdAt: readStringColumn(row, "created_at"),
});

export const hydrateRecordFromRow = async (
  tx: SqlExecutor,
  key: RecordKey,
  row: SqlRow,
): Promise<CheguersRecord> => {
  const data = readJsonObjectColumn(row, "data");
  const labelRows = await tx.all(
    `SELECT l.name AS name FROM record_labels rl JOIN labels l ON l.id = rl.label_id
     WHERE rl.record_id = ? ORDER BY l.name`,
    key.numericId,
  );
  return {
    id: readRecordIdColumn(row, "public_id"),
    data,
    labels: labelRows.map((labelRow) => readLabelNameColumn(labelRow, "name")),
    createdAt: readStringColumn(row, "created_at"),
    updatedAt: readStringColumn(row, "updated_at"),
  };
};

export const hydrateRecordsFromRows = async (
  tx: SqlExecutor,
  rows: ReadonlyArray<SqlRow>,
): Promise<ReadonlyArray<CheguersRecord>> => {
  const result: Array<CheguersRecord> = [];
  for (const row of rows) {
    result.push(await hydrateRecordFromRow(tx, recordKeyFromRow(row), row));
  }
  return result;
};

export const readCountColumn = (row: SqlRow, column: string): number =>
  readNumberColumn(row, column);
