# CheguersDB

An embedded, TypeScript-first graph + vector database layer on top of Turso.
Built with Effect v4.

See [docs/plan.md](docs/plan.md) for the full architecture and roadmap and
[docs/usage.md](docs/usage.md) for the complete usage guide.

## Packages

- `packages/core` — embedded database core (`@cheguers/core`)
- `packages/cli` — thin JSON CLI over the core (`@cheguers/cli`)
- `packages/benchmark` — benchmark harness for optimization decisions

## CLI

`packages/cli` is a thin transport over the public core API — no SQL, no
internal IDs, JSON in/out. Run it with `pnpm --filter @cheguers/cli cheguers`
or `npx tsx packages/cli/src/cli.ts`.

```console
$ cheguers import demo.db company.json --labels Company
$ cheguers bulk   demo.db people.json
$ cheguers query  demo.db --labels employees --where '{"property":"age","op":"gte","value":40}' --order age:desc
$ cheguers traverse demo.db --start <recordId> --max-depth 3 --paths
$ cheguers vec-upsert demo.db <recordId> --vector 0.9,0.8,0.1 --namespace skills
$ cheguers vec-search demo.db --vector 0.9,0.8,0.1 --namespace skills --top-k 3 --labels employees
$ cheguers hybrid demo.db --vector 0.9,0.8,0.1 --namespace skills --seeds 2 --expand-depth 1 --provenance
$ cheguers schema demo.db
$ cheguers stats  demo.db
```

## Quick start

```ts
import { open } from "@cheguers/core";
import { Effect } from "effect";

const db = await Effect.runPromise(open("./my.db"));

const record = await Effect.runPromise(
  db.records.create({ data: { name: "alice" }, labels: ["person"] }),
);
// => { id: "rec_…", data: { name: "alice" }, labels: ["person"], … }

await Effect.runPromise(db.close);
```

## Supported API surface (v0.1)

All public IDs are stable strings (`rec_…`, `rel_…`). Internal integer IDs and
SQL never cross the public boundary; user values are always parameterized.

### Records — `db.records`

| Operation    | Signature                                                                 |
| ------------ | ------------------------------------------------------------------------- |
| create       | `(input: CreateRecordInput) => Effect<CheguersRecord, CheguersError>`     |
| get          | `(id: string) => Effect<CheguersRecord, CheguersError>`                   |
| update       | `(id, input: UpdateRecordInput) => Effect<CheguersRecord, CheguersError>` |
| delete       | `(id: string) => Effect<void, CheguersError>`                             |
| listByLabels | `(labels) => Effect<CheguersRecord[], CheguersError>`                     |

Update data is a shallow JSON merge on top of stored data. Deleting a record
atomically removes its labels, vectors, and incident relationships.

### Relationships — `db.relationships`

create / get / delete / outgoing / incoming, optionally filtered by
relationship type. The edge table is the canonical graph representation.

### Nested import — `db.imports`

- `run(input, options)` normalizes nested JSON (nested objects → child records,
  arrays of objects → multiple related children, scalars/scalar arrays stay as
  properties; relationship types derive deterministically from nesting keys)
  and executes it as one atomic transaction.

### Schema introspection — `db.schema`

Type inference over observed properties per label (string / number / boolean /
null), tracked in a metadata-only catalog. Canonical user JSON is never
modified.

### Query DSL — `db.query.find`

`find(query: RecordQuery) => Effect<CheguersRecord[], CheguersError>` with:

- record id, label, and property filters;
- comparison (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`), membership (`in`,
  `notIn`), string (`contains`, `startsWith`, `endsWith`), and `exists`
  operators;
- logical AND/OR/NOT composition;
- bounded related-record graph predicates (`related`) with direction,
  relationship type, 1–3 hop ranges, and nested predicates — compiled to
  indexed EXISTS chains;
- ordering and offset/limit pagination with deterministic tie-breaking.

No raw SQL path exists; the compiler emits parameterized SQL from validated
ASTs only.

### Traversal — `db.traversal.traverse`

Bounded traversal over the canonical edge table (depths 0–3) with two
strategies sharing one public contract:

```ts
db.traversal.traverse({
  startIds: ["rec_…"],
  direction: "outgoing", // outgoing | incoming | both
  relationshipTypes: ["link"],
  minDepth: 1,
  maxDepth: 3,
  limit: 1000, // result cap
  includePaths: true, // per-hit provenance paths
  strategy: "bfs", // bfs (default) | recursive-cte
});
```

- **`bfs`** — batched indexed adjacency scans; visited-set bookkeeping makes
  cycles safe. Canonical implementation.
- **`recursive-cte`** — SQL set-based evaluation used for differential testing
  and benchmarks. When the embedded Turso build lacks `WITH RECURSIVE` support
  (detected at open time via capability probing) it compiles to an equivalent
  unrolled per-level form with identical results.

Both produce identical hits, depths, and provenance — verified by differential
tests. Results are ordered by depth then stable id.

### Vectors — `db.vectors`

| Operation | Notes                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------- |
| upsert    | named namespace support, dimension validation + consistency per namespace, float32 BLOB storage |
| get       | metadata by record id + namespace                                                               |
| remove    | delete one namespace vector                                                                     |
| search    | exact cosine/L2 top-k search with optional max-distance threshold                               |

Search runs **filter-first**: labels, property predicates (same DSL as
`db.query.find`, including related-record predicates), or both narrow the
candidate set in SQL before any distance evaluation.

### HybridRAG — `db.hybrid.search`

**Mode A (filter → vector)** — `labels` and `where` (the full DSL: property,
logical, and related-record predicates) narrow candidates in SQL before any
distance evaluation.

**Mode B (vector → graph → rerank)** — vector top-k seeds → bounded graph
expansion → deterministic candidate aggregation → weighted rerank → final
top-n.

Signals: vector similarity, graph proximity (`1/(1+minDepth)`), seed-path
frequency, optional per-relationship-type weights, and a stable-id
tie-breaker. Ordering is fully deterministic across runs. Provenance (best
seed, seed score, graph depth, path count, path summary) is available via
`includeProvenance`.

### Transactions & bulk — `db.transaction` / `db.bulk`

`transaction((ops) => Effect<A>)` exposes records/relationships/vectors
mutations sharing **one** underlying Turso transaction: every mutation type
commits or rolls back atomically with no partial state.

Bulk operations match individual-operation semantics and run in one atomic
batch: `createRecords`, `createRelationships`, `upsertVectors`,
`deleteRecords`.

### Errors

Typed errors per plan §12/§13: `ValidationError`, `NotFoundError`,
`ConflictError`, `DatabaseError`, `TransactionError`.

## Development

```sh
pnpm install
pnpm lint        # oxlint + anti-slop
pnpm fmt         # oxfmt
pnpm fmt:check   # oxfmt (check only)
pnpm typecheck   # clean tsc across all packages
pnpm test        # vitest unit + property + integration tests against a real Turso file DB
pnpm bench       # benchmark harness (packages/benchmark)
```

## Status vs plan phases

Implemented: Phase 0 (workspace/TS/Vitest/oxlint/oxfmt/CI), Phase 1 (Turso adapter,
transactions, migrations, versioned schema, capability detection), Phase 2
(canonical schema incl. vector + catalog tables and indexes), Phase 3 (records

- labels with atomic delete semantics), Phase 4 (relationships with required
  indexes), Phase 5 (database-independent normalizer + transactional nested
  import), Phase 6 (schema inference + introspection), Phases 7–8 (query DSL,
  AST, parameterized SQL compiler, golden tests), Phase 9 (composable
  related-record predicates), Phase 10 (bounded BFS traversal 0–3 hops plus
  recursive-CTE strategy with differential tests), Phases 11–12 (vector
  persistence, cosine/L2 exact search, filter-first filtered vector search),
  Phase 13 (HybridRAG Mode A filter→vector and Mode B vector→graph→rerank with
  deterministic ranking and provenance), Phase 14 (explicit transactions + bulk
  APIs).

Release-gate checks in place: compiler golden tests asserting exact SQL +
parameter order, property-based tests for the query parser and nested-JSON
normalizer (fast-check), differential BFS-vs-CTE tests (including provenance
and close/reopen persistence), and persistence/reopen integration tests.

The benchmark harness covers ingestion (single + bulk throughput), traversal
1–3 hops, fanout sensitivity, BFS vs recursive-CTE, cosine/L2 vector search
(unfiltered, filtered, dimension sweep, candidate-size sweep), hybrid
filter-first and rerank-overhead latency percentiles, plus database size and
process RSS in the environment block.

Remaining for v0.1 polish: continued benchmark-driven optimization passes
(Phase 15) and release checks (Phase 16).
