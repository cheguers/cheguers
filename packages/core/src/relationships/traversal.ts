import { Context, Effect, Layer } from "effect";
import { ValidationError, type CheguersError } from "../errors.js";
import { isRecordId, isRelationshipType } from "../domain/ids.js";
import type { CheguersRecord } from "../domain/model.js";
import { TursoAdapter, type DatabaseCapabilities } from "../database/turso.js";
import type { SqlExecutor, SqlRow } from "../database/sql.js";
import {
  hydrateRecordsFromRows,
  readNumberColumn,
  readRecordIdColumn,
  readRelationshipTypeColumn,
  readStringColumn,
  sqlRowsFrom,
} from "../database/row-parsers.js";
import { isStringValue } from "../json/runtime.js";

export const TRAVERSAL_MIN_DEPTH = 0;
export const TRAVERSAL_MAX_DEPTH = 3;
export const DEFAULT_TRAVERSAL_LIMIT = 1000;
export const MAX_TRAVERSAL_LIMIT = 10000;
/** Upper bound on rows enumerated by CTE strategies. */
const MAX_CTE_ROWS = 200000;
const CHUNK_SIZE = 256;

export type TraversalStrategy = "bfs" | "recursive-cte";

export interface TraversalSpec {
  readonly startIds: ReadonlyArray<string>;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly relationshipTypes?: ReadonlyArray<string>;
  /** Depth of the start nodes themselves; starts are hits when minDepth <= 0. */
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly includePaths?: boolean;
  /**
   * Execution strategy. Both share the public traversal contract; the CTE
   * strategy exists for differential testing and benchmarks and degrades to an
   * equivalent unrolled form when the engine lacks WITH RECURSIVE support.
   * Defaults to "bfs", the canonical implementation.
   */
  readonly strategy?: TraversalStrategy;
}

export interface TraversalPathStep {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
}

export type PathList = ReadonlyArray<ReadonlyArray<TraversalPathStep>>;

export interface TraversalHit {
  readonly record: CheguersRecord;
  readonly depth: number;
}

export interface TraversalResult {
  readonly hits: ReadonlyArray<TraversalHit>;
  /** Parallel to hits; present only when the spec requested provenance. */
  readonly paths?: PathList;
}

interface EdgeMeta {
  readonly rowId: number;
  readonly sourceId: number;
  readonly targetId: number;
  readonly type: string;
}

interface VisitInfo {
  readonly depth: number;
  readonly parent: number | undefined;
  readonly edge: EdgeMeta | undefined;
}

const chunk = <T>(items: ReadonlyArray<T>): Array<ReadonlyArray<T>> => {
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
};

const validateSpec = (spec: TraversalSpec): void => {
  const fail = (message: string): void => {
    throw new ValidationError({ message });
  };
  if (!Array.isArray(spec.startIds) || spec.startIds.length === 0) {
    fail("traversal requires at least one start id");
  }
  for (const id of spec.startIds) {
    if (!isStringValue(id) || !isRecordId(id)) fail(`invalid start id: ${String(id)}`);
  }
  if (spec.direction !== "outgoing" && spec.direction !== "incoming" && spec.direction !== "both") {
    fail('direction must be "outgoing", "incoming", or "both"');
  }
  if (spec.relationshipTypes !== undefined) {
    if (!Array.isArray(spec.relationshipTypes)) fail("relationshipTypes must be an array");
    for (const t of spec.relationshipTypes) {
      if (!isStringValue(t) || !isRelationshipType(t)) {
        fail(`invalid relationship type filter: ${String(t)}`);
      }
    }
  }
  const minDepth = spec.minDepth ?? 1;
  const maxDepth = spec.maxDepth ?? Math.max(minDepth, 1);
  for (const [name, value] of [
    ["minDepth", minDepth],
    ["maxDepth", maxDepth],
  ] as const) {
    if (!Number.isInteger(value) || value < TRAVERSAL_MIN_DEPTH || value > TRAVERSAL_MAX_DEPTH) {
      fail(`${name} must be an integer between ${TRAVERSAL_MIN_DEPTH} and ${TRAVERSAL_MAX_DEPTH}`);
    }
  }
  if (minDepth > maxDepth) fail("minDepth must be <= maxDepth");
  const limit = spec.limit ?? DEFAULT_TRAVERSAL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRAVERSAL_LIMIT) {
    fail(`limit must be an integer in [1, ${MAX_TRAVERSAL_LIMIT}]`);
  }
  if (spec.strategy !== undefined && spec.strategy !== "bfs" && spec.strategy !== "recursive-cte") {
    fail('strategy must be "bfs" or "recursive-cte"');
  }
};

const parseEdgeMetaRow = (row: SqlRow): EdgeMeta => ({
  rowId: readNumberColumn(row, "id"),
  sourceId: readNumberColumn(row, "source_id"),
  targetId: readNumberColumn(row, "target_id"),
  type: readRelationshipTypeColumn(row, "type"),
});

const resolveStarts = (
  tx: SqlExecutor,
  startIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<SqlRow>, CheguersError> =>
  Effect.tryPromise({
    try: () =>
      sqlRowsFrom(
        tx.all(
          `SELECT id, public_id FROM records WHERE public_id IN (${startIds.map(() => "?").join(", ")})`,
          ...startIds,
        ),
      ),
    catch: (cause): CheguersError => new ValidationError({ message: "start lookup failed", cause }),
  });

/**
 * Shared tail: hydrate every retained node so provenance never exposes
 * internal ids, shape hits, and build optional paths.
 */
const finalizeTraversal = (
  tx: SqlExecutor,
  visited: ReadonlyMap<number, VisitInfo>,
  options: {
    readonly minDepth: number;
    readonly maxHits: number;
    readonly includePaths: boolean;
  },
  seedPublicById: ReadonlyMap<number, string>,
): Effect.Effect<TraversalResult, CheguersError> =>
  Effect.gen(function* () {
    const publicById = new Map<number, string>(seedPublicById);

    // Deterministic retention order approximating BFS visit order under caps:
    // depth first, then discovery edge id, then internal id.
    const orderedNodes: Array<{ internal: number; depth: number; edgeId: number }> = [];
    for (const [internal, info] of visited) {
      orderedNodes.push({
        internal,
        depth: info.depth,
        edgeId: info.edge?.rowId ?? Number.MAX_SAFE_INTEGER,
      });
    }
    orderedNodes.sort(
      (a, b) => a.depth - b.depth || a.edgeId - b.edgeId || a.internal - b.internal,
    );
    const internalsToHydrate: Array<number> = [];
    for (const entry of orderedNodes) {
      if (internalsToHydrate.length >= options.maxHits) break;
      internalsToHydrate.push(entry.internal);
    }

    if (internalsToHydrate.length === 0) {
      return { hits: [] };
    }

    const internalPlaceholders = internalsToHydrate.map(() => "?").join(", ");
    const recordRows = yield* Effect.tryPromise({
      try: () =>
        sqlRowsFrom(
          tx.all(
            `SELECT id, public_id, data, created_at, updated_at FROM records
             WHERE id IN (${internalPlaceholders})
             ORDER BY public_id ASC`,
            ...internalsToHydrate,
          ),
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "traversal hydration failed", cause }),
    });
    const hydratedRecords: ReadonlyArray<CheguersRecord> = yield* Effect.promise(() =>
      hydrateRecordsFromRows(tx, recordRows),
    );
    for (let i = 0; i < recordRows.length; i++) {
      publicById.set(readNumberColumn(recordRows[i]!, "id"), hydratedRecords[i]!.id);
    }

    const recordsByPublicId = new Map<string, CheguersRecord>(
      hydratedRecords.map((r) => [r.id, r]),
    );

    const buildPath = (internal: number): ReadonlyArray<TraversalPathStep> => {
      const stepsBack: Array<EdgeMeta> = [];
      let cursor: number | undefined = internal;
      while (cursor !== undefined) {
        const info = visited.get(cursor);
        if (info === undefined || info.edge === undefined) break;
        stepsBack.push(info.edge);
        cursor = info.parent;
      }
      stepsBack.reverse();
      return stepsBack.map((edge) => ({
        sourceId: publicById.get(edge.sourceId) ?? String(edge.sourceId),
        targetId: publicById.get(edge.targetId) ?? String(edge.targetId),
        type: edge.type,
      }));
    };

    interface HitLike {
      depth: number;
      publicId: string;
      record: CheguersRecord;
      path?: ReadonlyArray<TraversalPathStep>;
    }
    const hitsByPublicId = new Map<string, HitLike>();
    for (const row of recordRows) {
      const internal = readNumberColumn(row, "id");
      const info = visited.get(internal);
      if (info === undefined || info.depth < options.minDepth) continue;
      const record = recordsByPublicId.get(readRecordIdColumn(row, "public_id"));
      if (record === undefined) continue;
      const hit: HitLike = { depth: info.depth, publicId: record.id, record };
      if (options.includePaths) hit.path = buildPath(internal);
      hitsByPublicId.set(record.id, hit);
    }

    const ordered = [...hitsByPublicId.values()].sort(
      (a, b) => a.depth - b.depth || a.publicId.localeCompare(b.publicId),
    );

    const hits = ordered.map((h) => ({ record: h.record, depth: h.depth }));
    const result: TraversalResult = options.includePaths
      ? { hits, paths: ordered.map((h) => h.path!) }
      : { hits };
    return result;
  });

const buildDirectedArms = (
  types: ReadonlyArray<string>,
  direction: "outgoing" | "incoming" | "both",
): Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> => {
  const typeClause =
    types.length > 0 ? ` WHERE r.type IN (${types.map(() => "?").join(", ")})` : "";
  const arms: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  if (direction !== "incoming") {
    arms.push({
      sql: `SELECT r.source_id AS from_node, r.target_id AS neighbor, r.id AS eid
            FROM relationships r${typeClause}`,
      params: types,
    });
  }
  if (direction !== "outgoing") {
    arms.push({
      sql: `SELECT r.target_id AS from_node, r.source_id AS neighbor, r.id AS eid
            FROM relationships r${typeClause}`,
      params: types,
    });
  }
  return arms;
};

/**
 * Bounded iterative BFS over the canonical edge table using batched indexed
 * adjacency queries. Visited-set bookkeeping makes cycles impossible to loop.
 * Discovery parents resolve deterministically to the minimum edge id among all
 * shortest-path discovery edges.
 */
export const traverseBfsInTx = (
  tx: SqlExecutor,
  spec: TraversalSpec,
): Effect.Effect<TraversalResult, CheguersError> =>
  Effect.gen(function* () {
    try {
      validateSpec(spec);
    } catch (error) {
      return yield* Effect.fail(
        error instanceof ValidationError
          ? error
          : new ValidationError({
              message: error instanceof Error ? error.message : "invalid traversal spec",
              cause: error,
            }),
      );
    }

    const minDepth = spec.minDepth ?? 1;
    const maxDepth = spec.maxDepth ?? Math.max(minDepth, 1);
    const limit = spec.limit ?? DEFAULT_TRAVERSAL_LIMIT;
    const maxVisits = limit + spec.startIds.length;
    const types = [...new Set(spec.relationshipTypes ?? [])].sort();

    const startRows = yield* resolveStarts(tx, spec.startIds);
    const foundIds = new Set(startRows.map((r) => readStringColumn(r, "public_id")));
    const missing = [...new Set(spec.startIds.filter((id) => !foundIds.has(id)))];
    if (missing.length > 0) {
      return yield* Effect.fail(
        new ValidationError({ message: `start records do not exist: ${missing.join(", ")}` }),
      );
    }

    const seedPublicById = new Map<number, string>();
    const visited = new Map<number, VisitInfo>();
    for (const row of startRows) {
      const internal = readNumberColumn(row, "id");
      seedPublicById.set(internal, readRecordIdColumn(row, "public_id"));
      visited.set(internal, { depth: 0, parent: undefined, edge: undefined });
    }

    let frontier: Array<number> = [...visited.keys()];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      // Whole-level candidate map so cap filling follows the deterministic
      // (edge id, internal id) order regardless of adjacency scan order.
      const nextLevel = new Map<number, { edge: EdgeMeta; parent: number }>();

      for (const batch of chunk(frontier)) {
        const batchSet = new Set(batch);
        const mergedEdges: Array<EdgeMeta> = [];

        const placeholders = batch.map(() => "?").join(", ");
        const typeClause =
          types.length > 0 ? ` AND type IN (${types.map(() => "?").join(", ")})` : "";
        const fetchEdges = (
          column: "source_id" | "target_id",
          allowed: boolean,
        ): Effect.Effect<ReadonlyArray<SqlRow>, CheguersError> =>
          !allowed
            ? Effect.succeed([])
            : Effect.tryPromise({
                try: () =>
                  sqlRowsFrom(
                    tx.all(
                      `SELECT id, source_id, target_id, type FROM relationships
                       WHERE ${column} IN (${placeholders})${typeClause}
                       ORDER BY id ASC`,
                      ...batch,
                      ...types,
                    ),
                  ),
                catch: (cause): CheguersError =>
                  new ValidationError({ message: "adjacency scan failed", cause }),
              });

        const outgoingRows = yield* fetchEdges("source_id", spec.direction !== "incoming");
        const incomingRows = yield* fetchEdges("target_id", spec.direction !== "outgoing");
        const pushEdges = (rows: ReadonlyArray<SqlRow>): void => {
          for (const row of rows) {
            mergedEdges.push(parseEdgeMetaRow(row));
          }
        };
        pushEdges(outgoingRows);
        pushEdges(incomingRows);

        for (const edge of mergedEdges) {
          if (edge.sourceId === edge.targetId) continue;
          if (batchSet.has(edge.sourceId) && batchSet.has(edge.targetId)) continue;
          // Every fetched edge touches the batch on one side, which sits in
          // the previous frontier; the opposite endpoint is the candidate.
          const neighbor = batchSet.has(edge.sourceId) ? edge.targetId : edge.sourceId;
          const parent = batchSet.has(edge.sourceId) ? edge.sourceId : edge.targetId;
          if (visited.has(neighbor)) continue;
          const existing = nextLevel.get(neighbor);
          if (existing === undefined || edge.rowId < existing.edge.rowId) {
            nextLevel.set(neighbor, { edge, parent });
          }
        }
      }

      // Merge discoveries until the visit budget is exhausted, lowest edge id
      // first; ties resolve by internal id for full determinism.
      const pending = [...nextLevel.entries()].sort(
        (a, b) => a[1].edge.rowId - b[1].edge.rowId || a[0] - b[0],
      );
      for (const [neighbor, discovery] of pending) {
        if (visited.size >= maxVisits) break;
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, { depth, parent: discovery.parent, edge: discovery.edge });
      }

      frontier = [...visited.entries()]
        .filter(([, info]) => info.depth === depth)
        .map(([internal]) => internal);
    }

    return yield* finalizeTraversal(
      tx,
      visited,
      { minDepth, maxHits: maxVisits, includePaths: spec.includePaths === true },
      seedPublicById,
    );
  });

/** Rows carrying minimum-hop discovery information per reached node. */
interface DiscoveryRow {
  readonly node: number;
  readonly depth: number;
  readonly edgeId: number;
}

/**
 * Recursive-CTE strategy. When the engine supports WITH RECURSIVE the natural
 * recursive form runs; otherwise it compiles to an equivalent unrolled
 * per-level plain-CTE set expansion (identical semantics for bounded depth).
 * Both share TypeScript-side deduplication: minimum hop distance wins, ties on
 * discovery resolve to the minimum edge id, mirroring BFS bookkeeping exactly.
 */
export const traverseCteInTx = (
  tx: SqlExecutor,
  spec: TraversalSpec,
  capabilities: DatabaseCapabilities,
): Effect.Effect<TraversalResult, CheguersError> =>
  Effect.gen(function* () {
    try {
      validateSpec(spec);
    } catch (error) {
      return yield* Effect.fail(
        error instanceof ValidationError
          ? error
          : new ValidationError({
              message: error instanceof Error ? error.message : "invalid traversal spec",
              cause: error,
            }),
      );
    }

    const minDepth = spec.minDepth ?? 1;
    const maxDepth = spec.maxDepth ?? Math.max(minDepth, 1);
    const limit = spec.limit ?? DEFAULT_TRAVERSAL_LIMIT;
    const maxVisits = limit + spec.startIds.length;
    const types = [...new Set(spec.relationshipTypes ?? [])].sort();

    const startRows = yield* resolveStarts(tx, spec.startIds);
    const foundIds = new Set(startRows.map((r) => readStringColumn(r, "public_id")));
    const missing = [...new Set(spec.startIds.filter((id) => !foundIds.has(id)))];
    if (missing.length > 0) {
      return yield* Effect.fail(
        new ValidationError({ message: `start records do not exist: ${missing.join(", ")}` }),
      );
    }

    const arms = buildDirectedArms(types, spec.direction);
    // NOTE: no parentheses around union members — some embedded Turso builds
    // reject parenthesized compound-select operands.
    const directedJoin = arms.map((a) => a.sql).join("\nUNION ALL\n");
    const armParams = arms.flatMap((a) => [...a.params]);

    let traversalSql: string;
    const baseParams: Array<unknown> = [...spec.startIds];

    if (capabilities.recursiveCte) {
      traversalSql = `
        WITH RECURSIVE
        dirs(from_node, neighbor, eid) AS (${directedJoin}),
        trav(node, depth, edge_id) AS (
          SELECT s.id, 0, -1
          FROM records s
          WHERE s.public_id IN (${spec.startIds.map(() => "?").join(", ")})
          UNION ALL
          SELECT d.neighbor, t.depth + 1, d.eid
          FROM trav t
          JOIN dirs d ON d.from_node = t.node
          WHERE t.depth < ${maxDepth}
            AND d.neighbor <> t.node
        )
        SELECT node, depth, edge_id FROM trav
        LIMIT ${MAX_CTE_ROWS}`;
    } else {
      // Unrolled bounded recursion: one plain CTE level per hop. No anti-join
      // exclusions are needed because depth is bounded and TypeScript-side
      // deduplication keeps the minimum hop distance per node (some embedded
      // Turso builds evaluate NOT IN subqueries over CTEs incorrectly).
      const levels: Array<string> = [];
      for (let depth = 1; depth <= maxDepth; depth++) {
        levels.push(`
          l${depth}(node, eid) AS (
            SELECT d.neighbor, d.eid
            FROM l${depth - 1} p
            JOIN dirs d ON d.from_node = p.node
            WHERE d.neighbor <> p.node
          )`);
      }
      const projection = [`SELECT node, 0 AS depth, eid FROM l0`];
      for (let depth = 1; depth <= maxDepth; depth++) {
        projection.push(`SELECT node, ${depth} AS depth, eid FROM l${depth}`);
      }
      traversalSql = `
        WITH
        l0(node, owner, eid) AS (
          SELECT s.id, -1, -1
          FROM records s
          WHERE s.public_id IN (${spec.startIds.map(() => "?").join(", ")})
        ),
        dirs(from_node, neighbor, eid) AS (${directedJoin})${
          levels.length > 0 ? "," + levels.join(",") : ""
        }
        ${projection.join("\nUNION ALL\n")}
        LIMIT ${MAX_CTE_ROWS}`;
    }

    // Parameter order must follow SQL text order. The recursive form declares
    // dirs (type parameters) before trav (start ids); the unrolled form
    // declares l0 (start ids) before dirs.
    const allParams: Array<unknown> = capabilities.recursiveCte
      ? [...armParams, ...baseParams]
      : [...baseParams, ...armParams];
    const rows = yield* Effect.tryPromise({
      try: () => sqlRowsFrom(tx.all(traversalSql, ...allParams)),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "cte traversal failed", cause }),
    });

    interface Best {
      depth: number;
      edgeId: number;
    }
    const bestByNode = new Map<number, Best>();
    const discoveries: DiscoveryRow[] = [];
    for (const row of rows) {
      const node = readNumberColumn(row, "node");
      const depth = readNumberColumn(row, "depth");
      // Recursive form names the column edge_id; unrolled forms project eid.
      const edgeId =
        row.edge_id !== undefined
          ? readNumberColumn(row, "edge_id")
          : row.eid !== undefined
            ? readNumberColumn(row, "eid")
            : -1;
      const current = bestByNode.get(node);
      if (
        current === undefined ||
        depth < current.depth ||
        (depth === current.depth && edgeId >= 0 && edgeId < current.edgeId)
      ) {
        bestByNode.set(node, { depth, edgeId });
      }
    }
    for (const [node, best] of bestByNode) {
      discoveries.push({ node, depth: best.depth, edgeId: best.edgeId });
    }

    const seedPublicById = new Map<number, string>();
    const visited = new Map<number, VisitInfo>();
    for (const row of startRows) {
      const internal = readNumberColumn(row, "id");
      seedPublicById.set(internal, readRecordIdColumn(row, "public_id"));
      visited.set(internal, { depth: 0, parent: undefined, edge: undefined });
    }

    // Fetch winning discovery edges to reconstruct full provenance.
    const winningEdges = new Set<number>();
    for (const d of discoveries) {
      if (d.edgeId >= 0) winningEdges.add(d.edgeId);
    }
    const edgeById = new Map<number, EdgeMeta>();
    if (winningEdges.size > 0) {
      const edgeIds = [...winningEdges].sort((a, b) => a - b);
      for (const batch of chunk(edgeIds)) {
        const placeholders = batch.map(() => "?").join(", ");
        const edgeRows = yield* Effect.tryPromise({
          try: () =>
            sqlRowsFrom(
              tx.all(
                `SELECT id, source_id, target_id, type FROM relationships
                 WHERE id IN (${placeholders})`,
                ...batch,
              ),
            ),
          catch: (cause): CheguersError =>
            new ValidationError({ message: "cte edge lookup failed", cause }),
        });
        for (const row of edgeRows) {
          const edge = parseEdgeMetaRow(row);
          edgeById.set(edge.rowId, edge);
        }
      }
    }

    for (const d of discoveries) {
      if (d.depth === 0) continue;
      const edge = edgeById.get(d.edgeId);
      if (edge === undefined) continue;
      const parent = edge.sourceId === d.node ? edge.targetId : edge.sourceId;
      visited.set(d.node, { depth: d.depth, parent, edge });
    }

    return yield* finalizeTraversal(
      tx,
      visited,
      { minDepth, maxHits: maxVisits, includePaths: spec.includePaths === true },
      seedPublicById,
    );
  });

export const traverseInTx = traverseBfsInTx;

export class TraversalService extends Context.Service<TraversalService, TraversalApi>()(
  "cheguers/db/TraversalService",
) {}

export interface TraversalApi {
  readonly traverse: (spec: TraversalSpec) => Effect.Effect<TraversalResult, CheguersError>;
}

export const makeTraversalService: Effect.Effect<TraversalApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;
    const capabilities = adapter.capabilities;
    return {
      traverse: (spec) =>
        adapter.transact((tx) =>
          spec.strategy === "recursive-cte"
            ? traverseCteInTx(tx, spec, capabilities)
            : traverseBfsInTx(tx, spec),
        ),
    };
  },
);

export const traversalLayer = Layer.effect(TraversalService, makeTraversalService);
