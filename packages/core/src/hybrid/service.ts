import { Context, Effect, Layer } from "effect";
import { ValidationError, type CheguersError } from "../errors.js";
import type { CheguersRecord, VectorMetric } from "../domain/model.js";
import { TursoAdapter } from "../database/turso.js";
import type { SqlExecutor, SqlRow } from "../database/sql.js";
import {
  hydrateRecordsFromRows,
  readNumberColumn,
  readRelationshipTypeColumn,
  sqlRowsFrom,
} from "../database/row-parsers.js";
import { isNumberValue } from "../json/runtime.js";
import type { WhereExpression } from "../query/types.js";
import { searchVectorsInTx, type VectorSearchInput } from "../vector/service.js";
import { similarityScore } from "../vector/math.js";

export const DEFAULT_EXPAND_DEPTH = 1;

/**
 * Deterministic reranking weights. Provided values are normalized to sum to 1;
 * omitted values fall back to these defaults.
 */
export interface HybridRerankWeights {
  readonly vector?: number;
  readonly proximity?: number;
  readonly frequency?: number;
}

/** Optional per-relationship-type weight applied along expansion paths. */
export type RelationWeights = Readonly<Record<string, number>>;

export interface HybridQuery {
  readonly vector: ReadonlyArray<number>;
  readonly namespace?: string;
  readonly metric: VectorMetric;
  /** Number of vector seeds (Mode B top-k). Defaults to 10. */
  readonly seeds?: number;
  readonly maxDistance?: number;
  /** Labels every seed record must carry (Mode A filter-first narrowing). */
  readonly labels?: ReadonlyArray<string>;
  /** Property/graph predicates applied before distance evaluation (Mode A). */
  readonly where?: WhereExpression;
  /** Graph expansion hops beyond each seed; 0 disables expansion. */
  readonly expandDepth?: number;
  readonly direction?: "outgoing" | "incoming" | "both";
  readonly relationshipTypes?: ReadonlyArray<string>;
  readonly relationWeights?: RelationWeights;
  readonly weights?: HybridRerankWeights;
  readonly topN?: number;
  readonly includeProvenance?: boolean;
}

export interface HybridProvenance {
  /** Seed that produced this candidate's best contribution. */
  readonly seedId: string | undefined;
  readonly bestSeedScore: number;
  readonly graphDepth: number;
  readonly pathCount: number;
  readonly finalScore: number;
  readonly pathSummary: string | undefined;
}

export interface HybridHit {
  readonly record: CheguersRecord;
  readonly score: number;
  readonly provenance?: HybridProvenance;
}

interface SeedInfo {
  readonly publicId: string;
  readonly internalId: number;
  readonly similarity: number;
}

interface Contribution {
  readonly sim: number;
  readonly depth: number;
  readonly factor: number;
}

const contributionValue = (c: Contribution): number =>
  c.sim * Math.pow(SEED_DECAY, c.depth) * c.factor;

/** Geometric decay of a seed's contribution with traversal depth. */
export const SEED_DECAY = 0.85;

/** Upper bound on tracked (seed, node) expansion states. */
const MAX_EXPANSION_STATES = 50000;
const MAX_PATH_SUMMARY_HOPS = 8;

interface FrontierState {
  readonly seedIdx: number;
  readonly node: number;
  readonly depth: number;
  readonly factor: number;
}

interface CandidateState {
  best: Contribution | undefined;
  /** Seed public id associated with the best contribution. */
  bestSeed: string | undefined;
  minDepth: number;
  seedArrivals: Set<string>;
}

interface ParentRef {
  readonly prev: number;
  readonly type: string;
}

const validateQuery = (query: HybridQuery): void => {
  const fail = (message: string): void => {
    throw new ValidationError({ message });
  };
  if (query.metric !== "cosine" && query.metric !== "l2") fail("metric must be cosine or l2");
  const topN = query.topN ?? 10;
  if (!Number.isInteger(topN) || topN < 1) fail("topN must be a positive integer");
  const seeds = query.seeds ?? 10;
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 1000) {
    fail("seeds must be an integer in [1, 1000]");
  }
  const expandDepth = query.expandDepth ?? DEFAULT_EXPAND_DEPTH;
  if (!Number.isInteger(expandDepth) || expandDepth < 0 || expandDepth > 3) {
    fail("expandDepth must be an integer between 0 and 3");
  }
  if (
    query.direction !== undefined &&
    query.direction !== "outgoing" &&
    query.direction !== "incoming" &&
    query.direction !== "both"
  ) {
    fail('direction must be "outgoing", "incoming", or "both"');
  }
  for (const [name, value] of [
    ["weights.vector", query.weights?.vector],
    ["weights.proximity", query.weights?.proximity],
    ["weights.frequency", query.weights?.frequency],
  ] as const) {
    if (value === undefined) continue;
    if (!isNumberValue(value) || value < 0) {
      fail(`${name} must be a finite non-negative number`);
    }
  }
};

type NormalizedHybridWeights = {
  vector: number;
  proximity: number;
  frequency: number;
};

const normalizeWeights = (weights: HybridRerankWeights | undefined): NormalizedHybridWeights => {
  const raw = {
    vector: weights?.vector ?? 0.6,
    proximity: weights?.proximity ?? 0.3,
    frequency: weights?.frequency ?? 0.1,
  } satisfies { vector: number; proximity: number; frequency: number };
  const total = raw.vector + raw.proximity + raw.frequency;
  if (!(total > 0)) return { vector: 1 / 3, proximity: 1 / 3, frequency: 1 / 3 };
  return {
    vector: raw.vector / total,
    proximity: raw.proximity / total,
    frequency: raw.frequency / total,
  };
};

interface RelationshipHop {
  readonly neighbor: number;
  readonly type: string;
  readonly sourceId: number;
  readonly targetId: number;
}

type VectorSearchDraft = {
  vector: ReadonlyArray<number>;
  metric: VectorMetric;
  topK: number;
  namespace?: string;
  maxDistance?: number;
  labels?: ReadonlyArray<string>;
  where?: HybridQuery["where"];
};

const buildVectorSearchInput = (query: HybridQuery, metric: VectorMetric): VectorSearchInput => {
  const input: VectorSearchDraft = {
    vector: query.vector,
    metric,
    topK: query.seeds ?? 10,
  };
  if (query.namespace !== undefined) input.namespace = query.namespace;
  if (query.maxDistance !== undefined) input.maxDistance = query.maxDistance;
  if (query.labels !== undefined) input.labels = query.labels;
  if (query.where !== undefined) input.where = query.where;
  // SAFETY: optional fields are added only when defined; draft shape matches VectorSearchInput.
  return input as VectorSearchInput;
};

const parseRelationshipHopRow = (
  row: SqlRow,
  neighborColumn: "source_id" | "target_id",
): RelationshipHop => ({
  neighbor: readNumberColumn(row, neighborColumn),
  type: readRelationshipTypeColumn(row, "type"),
  sourceId: readNumberColumn(row, "source_id"),
  targetId: readNumberColumn(row, "target_id"),
});

/**
 * Mode B execution: vector top-k seeds -> bounded graph expansion ->
 * deterministic candidate aggregation -> weighted rerank -> final top-n.
 * Ordering is fully deterministic: score desc, then stable record-id
 * tie-breaker.
 */
export const searchHybridInTx = (
  tx: SqlExecutor,
  query: HybridQuery,
): Effect.Effect<ReadonlyArray<HybridHit>, CheguersError> =>
  Effect.gen(function* () {
    try {
      validateQuery(query);
    } catch (error) {
      if (error instanceof ValidationError) {
        return yield* Effect.fail(error);
      }
      return yield* Effect.fail(
        new ValidationError({
          message: error instanceof Error ? error.message : "invalid hybrid query",
          cause: error,
        }),
      );
    }

    const metric: VectorMetric = query.metric === "l2" ? "l2" : "cosine";
    const topN = query.topN ?? 10;
    const expandDepth = query.expandDepth ?? DEFAULT_EXPAND_DEPTH;
    const direction = query.direction ?? "both";
    const weights = normalizeWeights(query.weights);
    const relationWeights = query.relationWeights ?? {};
    const types =
      query.relationshipTypes !== undefined ? [...new Set(query.relationshipTypes)].sort() : [];

    // Stage 1: filter-first vector retrieval produces the ranked seed set.
    // Labels/property/related predicates narrow candidates in SQL before any
    // distance computation (Mode A: filter -> vector).
    const seedHits = yield* searchVectorsInTx(tx, buildVectorSearchInput(query, metric));

    const seeds: SeedInfo[] = [];
    for (const hit of seedHits) {
      const row = yield* Effect.tryPromise({
        try: () => tx.get("SELECT id FROM records WHERE public_id = ?", hit.record.id),
        catch: (cause): CheguersError =>
          new ValidationError({ message: "seed resolution failed", cause }),
      });
      if (row === undefined) continue;
      seeds.push({
        publicId: hit.record.id,
        internalId: readNumberColumn(row, "id"),
        similarity: similarityScore(metric, hit.distance),
      });
    }

    const candidates = new Map<number, CandidateState>();
    const parents = new Map<number, ParentRef>();

    const recordCandidate = (internalId: number, c: Contribution, seedKey: string): void => {
      let state = candidates.get(internalId);
      if (state === undefined) {
        state = {
          best: undefined,
          bestSeed: undefined,
          minDepth: Number.MAX_SAFE_INTEGER,
          seedArrivals: new Set(),
        };
        candidates.set(internalId, state);
      }
      const isNewBest =
        state.best === undefined ||
        contributionValue(c) > contributionValue(state.best) ||
        (contributionValue(c) === contributionValue(state.best) && c.depth < state.best.depth) ||
        (contributionValue(c) === contributionValue(state.best) &&
          c.depth === state.best.depth &&
          seedKey.localeCompare(state.bestSeed ?? "") < 0);
      if (isNewBest) {
        state.best = c;
        state.bestSeed = seedKey;
      }
      state.minDepth = Math.min(state.minDepth, c.depth);
      state.seedArrivals.add(seedKey);
    };

    if (seeds.length === 0) return [];

    let frontierStates: Array<FrontierState> = [];
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      recordCandidate(
        seed.internalId,
        { sim: seed.similarity, depth: 0, factor: 1 },
        seed.publicId,
      );
      frontierStates.push({ seedIdx: i, node: seed.internalId, depth: 0, factor: 1 });
    }

    let stateCount = 0;
    for (let depth = 1; depth <= expandDepth && frontierStates.length > 0; depth++) {
      interface NextHop {
        neighbor: number;
        type: string;
        sourceId: number;
        targetId: number;
      }
      // Batch adjacency over unique frontier nodes for one indexed scan set.
      const nodeSet = new Set(frontierStates.map((s) => s.node));
      const nodes = [...nodeSet];
      const outgoingEdges: Array<NextHop> = [];
      const incomingEdges: Array<NextHop> = [];

      const CHUNK = 256;
      for (let start = 0; start < nodes.length; start += CHUNK) {
        const batch = nodes.slice(start, start + CHUNK);
        const placeholders = batch.map(() => "?").join(", ");
        const typeClause =
          types.length > 0 ? ` AND type IN (${types.map(() => "?").join(", ")})` : "";

        if (direction !== "incoming") {
          const rows = yield* Effect.tryPromise({
            try: () =>
              sqlRowsFrom(
                tx.all(
                  `SELECT source_id, target_id, type FROM relationships
                   WHERE source_id IN (${placeholders})${typeClause}
                   ORDER BY id ASC`,
                  ...batch,
                  ...types,
                ),
              ),
            catch: (cause): CheguersError =>
              new ValidationError({ message: "hybrid expansion failed", cause }),
          });
          for (const r of rows) {
            outgoingEdges.push(parseRelationshipHopRow(r, "target_id"));
          }
        }
        if (direction !== "outgoing") {
          const rows = yield* Effect.tryPromise({
            try: () =>
              sqlRowsFrom(
                tx.all(
                  `SELECT source_id, target_id, type FROM relationships
                   WHERE target_id IN (${placeholders})${typeClause}
                   ORDER BY id ASC`,
                  ...batch,
                  ...types,
                ),
              ),
            catch: (cause): CheguersError =>
              new ValidationError({ message: "hybrid expansion failed", cause }),
          });
          for (const r of rows) {
            incomingEdges.push(parseRelationshipHopRow(r, "source_id"));
          }
        }
      }

      // Index edges by their in-frontier endpoint so each state expands once.
      const nextStates: Array<FrontierState> = [];
      const seenThisLevel = new Map<string, boolean>();
      for (const state of frontierStates) {
        const hops: Array<NextHop> = [];
        if (direction !== "incoming") {
          for (const edge of outgoingEdges) {
            if (edge.sourceId === state.node) hops.push(edge);
          }
        }
        if (direction !== "outgoing") {
          for (const edge of incomingEdges) {
            if (edge.targetId === state.node) hops.push(edge);
          }
        }
        hops.sort((a, b) => a.neighbor - b.neighbor || a.type.localeCompare(b.type));
        for (const hop of hops) {
          if (stateCount >= MAX_EXPANSION_STATES) break;
          const key = `${state.seedIdx}:${hop.neighbor}`;
          if (seenThisLevel.has(key)) continue;
          seenThisLevel.set(key, true);
          stateCount++;

          const typeFactor = relationWeights[hop.type] ?? 1;
          const safeFactor = Number.isFinite(typeFactor)
            ? Math.min(10, Math.max(0, typeFactor))
            : 1;
          nextStates.push({
            seedIdx: state.seedIdx,
            node: hop.neighbor,
            depth,
            factor: state.factor * safeFactor,
          });

          recordCandidate(
            hop.neighbor,
            {
              sim: seeds[state.seedIdx]!.similarity,
              depth,
              factor: state.factor * safeFactor,
            },
            seeds[state.seedIdx]!.publicId,
          );

          // Deterministic shortest-path provenance: the first parent write for
          // a node wins, and frontier states are processed in rank order.
          if (!parents.has(hop.neighbor)) {
            parents.set(hop.neighbor, { prev: state.node, type: hop.type });
          }
        }
      }

      // Mark nodes discovered this level so later seeds skip duplicate work;
      // contributions were already accumulated above.
      frontierStates = nextStates;
    }

    if (candidates.size === 0) return [];

    const internals = [...candidates.keys()];
    const placeholders = internals.map(() => "?").join(", ");
    const recordRows = yield* Effect.tryPromise({
      try: () =>
        sqlRowsFrom(
          tx.all(
            `SELECT id, public_id, data, created_at, updated_at FROM records
             WHERE id IN (${placeholders})
             ORDER BY public_id ASC`,
            ...internals,
          ),
        ),
      catch: (cause): CheguersError =>
        new ValidationError({ message: "hybrid hydration failed", cause }),
    });
    const hydratedRecords: ReadonlyArray<CheguersRecord> = yield* Effect.promise(() =>
      hydrateRecordsFromRows(tx, recordRows),
    );
    const publicById = new Map<number, string>();
    for (let i = 0; i < recordRows.length; i++) {
      publicById.set(readNumberColumn(recordRows[i]!, "id"), hydratedRecords[i]!.id);
    }

    const recordsByPublicId = new Map<string, CheguersRecord>(
      hydratedRecords.map((r) => [r.id, r]),
    );
    const scored: Array<{ internalId: number; record: CheguersRecord; state: CandidateState }> = [];
    for (const [internalId, state] of candidates) {
      const publicId = publicById.get(internalId);
      if (publicId === undefined) continue;
      const record = recordsByPublicId.get(publicId);
      if (record === undefined) continue;
      scored.push({ internalId, record, state });
    }

    const buildSummary = (internalId: number): string | undefined => {
      const hops: Array<{ type: string; toInternal: number }> = [];
      let cursor: number | undefined = internalId;
      while (cursor !== undefined && hops.length < MAX_PATH_SUMMARY_HOPS) {
        const parent = parents.get(cursor);
        if (parent === undefined) break;
        hops.push({ type: parent.type, toInternal: cursor });
        cursor = parent.prev;
      }
      if (hops.length === 0 || cursor === undefined) return undefined;
      const originPublicId = publicById.get(cursor);
      if (originPublicId === undefined) return undefined;
      hops.reverse();
      let text = originPublicId;
      for (const hop of hops) {
        const toPublicId = publicById.get(hop.toInternal) ?? String(hop.toInternal);
        text += ` --${hop.type}--> ${toPublicId}`;
      }
      return text;
    };

    const ranked: Array<HybridHit> = [];
    for (const entry of scored) {
      const { record, state } = entry;
      const bestValue = state.best === undefined ? 0 : contributionValue(state.best);
      const proximity = 1 / (1 + state.minDepth);
      const frequency = Math.min(1, state.seedArrivals.size / Math.max(1, seeds.length));
      const finalScore =
        weights.vector * bestValue + weights.proximity * proximity + weights.frequency * frequency;

      let provenance: HybridProvenance | undefined;
      if (query.includeProvenance === true) {
        provenance = {
          seedId: state.bestSeed,
          bestSeedScore: bestValue,
          graphDepth: state.minDepth,
          pathCount: state.seedArrivals.size,
          finalScore,
          pathSummary: buildSummary(entry.internalId),
        };
      }
      if (provenance !== undefined) {
        ranked.push({ record, score: finalScore, provenance });
      } else {
        ranked.push({ record, score: finalScore });
      }
    }

    // Deterministic ordering: final score desc, stable id tie-breaker.
    ranked.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
    return ranked.slice(0, topN);
  });

export class HybridService extends Context.Service<HybridService, HybridApi>()(
  "cheguers/db/HybridService",
) {}

export interface HybridApi {
  readonly search: (query: HybridQuery) => Effect.Effect<ReadonlyArray<HybridHit>, CheguersError>;
}

export const makeHybridService: Effect.Effect<HybridApi, never, TursoAdapter> = Effect.gen(
  function* () {
    const adapter = yield* TursoAdapter;
    return {
      search: (query) => adapter.transact((tx) => searchHybridInTx(tx, query)),
    };
  },
);

export const hybridLayer = Layer.effect(HybridService, makeHybridService);
