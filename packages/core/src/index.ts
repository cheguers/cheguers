export { open } from "./cheguersdb.js";
export type { CheguersDBHandle, CheguersDBApi } from "./cheguersdb.js";

export type {
  CheguersRecord,
  CheguersRelationship,
  CheguersVectorMeta,
  CreateRecordInput,
  CreateRelationshipInput,
  DeleteVectorInput,
  JsonArray,
  JsonObject,
  JsonValue,
  UpdateRecordInput,
  UpsertVectorInput,
  VectorMetric,
} from "./domain/model.js";
export type { VectorSearchHit } from "./domain/model.js";
export type {
  TraversalHit,
  TraversalPathStep,
  TraversalResult,
  TraversalApi,
  TraversalSpec,
} from "./relationships/traversal.js";
export type {
  HybridHit,
  HybridProvenance,
  HybridQuery,
  HybridRerankWeights,
  HybridApi,
  RelationWeights,
} from "./hybrid/service.js";
export type { VectorSearchInput, VectorApi } from "./vector/service.js";
export type { BulkDeleteResult, BulkApi, TransactionScope } from "./transactions/service.js";
export type { RecordId, RelationshipId, LabelName, RelationshipType } from "./domain/ids.js";
export { generateRecordId } from "./domain/ids.js";

export {
  isBooleanValue,
  isJsonArray,
  isNumberValue,
  isPlainObject,
  isStringValue,
  parseFiniteNumber,
  parseJsonObject,
  parseJsonValue,
} from "./json/runtime.js";

export type {
  ComparisonOperator,
  MembershipOperator,
  OrderBy,
  PropertyOperator,
  RecordQuery,
  RelatedSpec,
  StringOperator,
  WhereExpression,
} from "./query/types.js";

export type { ImportOptions, ImportResult } from "./import/service.js";
export type { ImportRecordSpec, NormalizedImport } from "./import/normalizer.js";

export type {
  CheguersError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  TransactionError,
  ValidationError,
} from "./errors.js";
