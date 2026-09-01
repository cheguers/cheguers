# CheguersDB Usage Guide

CheguersDB is an embedded, TypeScript-first graph + vector database layer on
top of Turso. It stores records with labels and JSON properties, typed
relationships between them, named vectors per record, and gives you a typed
query DSL, bounded graph traversal, exact vector search, and HybridRAG
(vector → graph → rerank) — all persisted in a single Turso database file.

There is no server. You open a file, you use it, you close it.

- Package: `packages/core` (`@cheguers/core`)
- CLI: `packages/cli` (`@cheguers/cli`)

---

## Contents

1. [Installation and setup](#1-installation-and-setup)
2. [Opening and closing a database](#2-opening-and-closing-a-database)
3. [Records and labels](#3-records-and-labels)
4. [Relationships](#4-relationships)
5. [Nested JSON import](#5-nested-json-import)
6. [Schema introspection](#6-schema-introspection)
7. [Query DSL](#7-query-dsl)
8. [Graph traversal](#8-graph-traversal)
9. [Vectors](#9-vectors)
10. [Hybrid search (HybridRAG)](#10-hybrid-search-hybridrag)
11. [Transactions](#11-transactions)
12. [Bulk operations](#12-bulk-operations)
13. [Error handling](#13-error-handling)
14. [The CLI](#14-the-cli)
15. [Rules the database enforces](#15-rules-the-database-enforces)

All TypeScript examples assume:

```ts
import { Effect } from "effect"
import { open } from "@cheguers/core"
```

Every database operation returns an `Effect` from the
[effect](https://effect.website) library. Effects are lazy — nothing touches
the database until you run them:

```ts
const result = await Effect.runPromise(db.records.create({ data: { name: "Ada" } }))
```

---

## 1. Installation and setup

The repository is a pnpm workspace. From the repository root:

```console
$ pnpm install
$ pnpm typecheck   # clean type-check
$ pnpm test        # full test suite
```

In your own code, import from `@cheguers/core`:

```ts
import { open } from "@cheguers/core"
```

Requirements: Node.js 20+, and `@tursodatabase/database` (installed
automatically as a dependency of the core package).

---

## 2. Opening and closing a database

`open(path)` creates the database file if it does not exist, runs all
migrations, and returns a handle. Everything hangs off that handle — there are
no other entry points.

```ts
const program = Effect.gen(function* () {
  const db = yield* open("./app.db")

  // ... use db ...

  yield* db.close
})

await Effect.runPromise(program)
```

The file persists everything: records, labels, relationships, vectors, and the
inferred schema catalog. Close and reopen freely — all data survives.

The handle shape:

```ts
interface CheguersDBHandle {
  records:       RecordsShape
  relationships: RelationshipsShape
  traversal:     TraversalShape
  imports:       NestedImportShape
  schema:        SchemaShape
  query:         QueryShape
  vectors:       VectorShape
  hybrid:        HybridShape
  transaction:   TransactionShape["run"]
  bulk:          BulkShape
  close:         Effect<void, CheguersError>
}
```

---

## 3. Records and labels

A record is a stable public string ID (`rec_...`), a JSON body, zero or more
labels, and timestamps. Labels are normalized identifiers
(`^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$` — letters/digits/underscore/dot/colon/
dash, must not start with a digit or dash).

### Create

```ts
const ada = yield* db.records.create({
  data: { name: "Ada Lovelace", age: 36, active: true },
  labels: ["Person", "Engineer"]
})
// ada.id        -> "rec_<32 hex chars>"
// ada.labels    -> ["Person", "Engineer"]
// ada.createdAt / ada.updatedAt -> ISO timestamps
```

You may supply your own stable ID: `db.records.create({ id: "user-424242", ... })`.
Custom IDs must match `^[A-Za-z][A-Za-z0-9_-]{7,127}$` (letter first, then
letters/digits/underscore/dash, 8–128 chars total). Duplicate IDs fail with
`ConflictError`.

### Read / update / delete

```ts
const ada2 = yield* db.records.get(ada.id)

// Update data is a SHALLOW MERGE on top of stored data.
// Labels are adjusted additively.
const updated = yield* db.records.update(ada.id, {
  data: { age: 37 },              // merges: other properties stay
  addLabels: ["Admin"],
  removeLabels: ["Engineer"]
})

yield* db.records.delete(ada.id)
```

Deleting a record is atomic and cascades: its labels, its vectors, and every
relationship touching it are removed in the same transaction.

### List by label

```ts
const engineers = yield* db.records.listByLabels(["Engineer"])
```

---

## 4. Relationships

Typed, directed edges between records with optional JSON properties. One
canonical edge table backs all graph features.

```ts
const rel = yield* db.relationships.create({
  type: "OWNS",                    // same identifier rules as labels
  sourceId: ada.id,
  targetId: projectId,
  properties: { role: "lead" }     // optional
})

const fetched = yield* db.relationships.get(rel.id)
yield* db.relationships.delete(rel.id)
```

Endpoints must exist; otherwise you get a `ValidationError`.

Incoming and outgoing lookups, optionally filtered by type:

```ts
const owned = yield* db.relationships.outgoing(ada.id)          // all
const ownsP = yield* db.relationships.outgoing(ada.id, "OWNS")  // one type
const fanIn = yield* db.relationships.incoming(projectId)
```

Deleting a relationship affects only that relationship. Deleting a record
deletes its incident relationships automatically.

---

## 5. Nested JSON import

The importer turns one nested JSON document into many records wired by
relationships — atomically. Either the whole document lands or nothing does.

Normalization rules:

- scalars become properties of the current record;
- nested objects become child records;
- arrays of objects become multiple child records;
- scalar arrays stay properties;
- the nesting key becomes the label and relationship type;
- relationship direction is parent → child.

```ts
const result = yield* db.imports.run(
  {
    title: "post-1",
    views: 12,
    tags: ["x", "y"],                                // scalar array -> property
    author: { name: "alice" },                       // object      -> child record
    comments: [{ body: "nice" }, { body: "more" }]   // objects     -> children
  },
  { rootLabels: ["Post"] }                           // optional labels for the root
)
```

Result:

```ts
result.rootId                 // public ID of the root record
result.recordsCreated         // 4  (root + author + 2 comments)
result.relationshipsCreated   // 3  (author + comments + comments)
result.labelsLinked           // 4
result.idsByLocalId           // { root: "rec_...", "root.author": "rec_...",
                              //   "root.comments.0": "rec_...", ... }
```

Notes:

- the root must be a plain JSON object (arrays, `null`, strings, numbers are
  rejected with `ValidationError`);
- nesting keys must be valid identifiers (they become labels/types);
- generated IDs are stable within the import and returned in `idsByLocalId`.

---

## 6. Schema introspection

Every write updates a schema catalog (label + property → inferred type,
observation count, first/last seen). The catalog is metadata only — your JSON
is always canonical and never modified.

```ts
const entries = yield* db.schema.introspect()
// [{ label: "Person", property: "age", inferredType: "number",
//    observations: 6, firstSeen: "...", lastSeen: "..." }, ...]

const justPeople = yield* db.schema.introspect({ label: "Person" })
```

Inferred types: `string`, `number`, `boolean`, `null` (plus datetime where
explicitly recognized).

---

## 7. Query DSL

`db.query.find` is the typed query surface. Public queries never accept raw
SQL; all values are parameterized; results are deterministically ordered
(your `orderBy` first, then record ID as tie-breaker).

```ts
const people = yield* db.query.find({
  labels: ["Person"],
  where: {
    and: [
      { property: "age", op: "gte", value: 40 },
      { property: "role", op: "eq", value: "engineer" }
    ]
  },
  orderBy: [{ property: "age", direction: "desc" }],
  limit: 10,
  offset: 0
})
```

### Operators

| Group | Operators |
| --- | --- |
| Comparison | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |
| String | `contains`, `startsWith`, `endsWith` |
| Membership | `in`, `notIn` (value is an array) |
| Existence | `exists` (no value needed) |

### Shape of a `where` expression

```ts
type WhereExpression =
  | { property: string; op: PropertyOperator; value?: JsonValue }
  | { and: WhereExpression[] }
  | { or: WhereExpression[] }
  | { not: WhereExpression }
  | { related: RelatedSpec }
```

Examples:

```ts
{ property: "name", op: "contains", value: "ada" }
{ property: "tags", op: "in", value: ["math", "cs"] }
{ or: [{ property: "age", op: "lt", value: 30 },
       { property: "active", op: "eq", value: true }] }
{ not: { property: "email", op: "exists" } }
```

### Graph predicates (`related`)

A `where` expression can reach through the edge table — with nested `where` on
the related records and multi-hop bounds:

```ts
// People who own a project that has a high-priority task
{
  related: {
    type: "OWNS",
    direction: "outgoing",     // or "incoming"
    maxHops: 2,
    where: {
      related: {
        type: "HAS_TASK",
        direction: "outgoing",
        where: { property: "priority", op: "eq", value: "high" }
      }
    }
  }
}
```

`related` composes freely with `and` / `or` / `not` and property predicates.

Invalid operators, malformed `where` shapes, and negative limits are rejected
before compilation (`ValidationError`) — bad queries never touch the engine.

---

## 8. Graph traversal

Bounded BFS over the canonical edge table. Traversal is **bounded by default**:
1–3 hops, explicit limits, cycle-safe.

```ts
const result = yield* db.traversal.traverse({
  startIds: [ada.id],                        // one or more start records
  direction: "outgoing",                     // "outgoing" | "incoming" | "both"
  relationshipTypes: ["OWNS", "HAS_TASK"],   // optional filter
  minDepth: 0,                               // 0 = include start records as hits
  maxDepth: 2,                               // hard bound: 0..3
  limit: 100,                                // max hits
  includePaths: true                         // per-hit provenance paths
})

// result.hits: [{ record: CheguersRecord, depth: number }, ...]
// result.paths (when includePaths: true): parallel array of
//   [{ sourceId, targetId, type }, ...] per hit
```

Defaults: `minDepth: 1` (start records are *not* hits unless `minDepth <= 0`),
`direction: "outgoing"`. Visited-set bookkeeping means cycles cannot loop
forever and each record is reported once, at its shallowest depth.

An alternative recursive-CTE strategy exists for differential testing and
benchmarks (`strategy: "cte"`); `"bfs"` is the default and canonical one.

---

## 9. Vectors

Named vectors are stored per record, separate from record JSON. A record can
carry multiple vectors under different namespaces. The default namespace is
`"default"`.

```ts
yield* db.vectors.upsert({
  recordId: ada.id,
  namespace: "skills",        // optional, defaults to "default"
  vector: [0.9, 0.8, 0.1]
})

const meta = yield* db.vectors.get(ada.id, "skills")
// { recordId, namespace: "skills", dimensions: 3, updatedAt }
```

Rules enforced on write:

- all components must be finite numbers (no NaN/Infinity);
- the vector must be non-empty;
- within one namespace every vector must have the same dimensions — a
  mismatch is a `ValidationError`;
- upserting again for the same (record, namespace) overwrites.

### Exact similarity search

```ts
const hits = yield* db.vectors.search({
  namespace: "skills",
  vector: [0.9, 0.8, 0.1],
  metric: "cosine",            // or "l2"
  topK: 5,
  maxDistance: 0.5,            // optional exclusive upper bound
  labels: ["Person"],          // optional: pre-filter by label
  where: { property: "active", op: "eq", value: true }  // optional pre-filter
})

// hits: [{ record: CheguersRecord, distance: number }, ...]
// distance: cosine distance (1 - similarity) or L2 distance
```

Search is exact (brute force) — the correctness baseline for any future ANN
index. Filters run **before** distance evaluation: when a label/property/graph
filter is selective, distance is only computed over qualifying candidates.

---

## 10. Hybrid search (HybridRAG)

`db.hybrid.search` combines vector ranking with graph structure in one call.

### Mode A — filter → vector (filter-first narrowing)

Restrict the seed set with labels/properties first, then rank by vector
similarity. Set `expandDepth: 0` to disable expansion:

```ts
const hits = yield* db.hybrid.search({
  vector: [0.9, 0.8, 0.1],
  metric: "cosine",
  labels: ["Person"],
  where: { property: "role", op: "eq", value: "engineer" },
  seeds: 10,          // size of the vector seed set (default 10)
  expandDepth: 0,
  topN: 5
})
```

### Mode B — vector → graph → rerank

Take the vector top-k seeds, expand through the graph, aggregate candidates,
and rerank deterministically:

```ts
const hits = yield* db.hybrid.search({
  vector: [0.9, 0.8, 0.1],
  metric: "cosine",
  seeds: 10,                                   // vector top-k
  expandDepth: 2,                              // graph hops (0..3)
  direction: "outgoing",
  relationshipTypes: ["OWNS", "HAS_TASK"],
  relationWeights: { OWNS: 2, HAS_TASK: 1 },   // optional per-type weight
  weights: { vector: 0.7, proximity: 0.2, frequency: 0.1 }, // optional
  topN: 10,
  includeProvenance: true
})

// hits: [{ record, score, provenance? }, ...] ordered by descending score
// provenance (when includeProvenance: true):
//   .seedId         seed that produced this candidate's best contribution
//   .bestSeedScore  best similarity from that seed
//   .graphDepth     hops from the seed
```

Reranking signals: vector similarity, graph depth (closer = better), number of
seed paths reaching the candidate, optional relationship-type weights, and a
stable ID tie-breaker. Ordering is fully deterministic — the same query and
data always produce the same ranking.

---

## 11. Transactions

`db.transaction(body)` gives you a scope whose operations all share one
underlying Turso transaction. If the body fails, everything rolls back — no
partial state is ever visible.

```ts
const result = yield* db.transaction((ops) =>
  Effect.gen(function* () {
    const post = yield* ops.records.create({
      data: { title: "hello" },
      labels: ["Post"]
    })
    const author = yield* ops.records.create({ data: { name: "ada" } })
    yield* ops.relationships.create({
      type: "WRITTEN_BY",
      sourceId: post.id,
      targetId: author.id
    })
    yield* ops.vectors.upsert({ recordId: post.id, vector: [1, 2, 3] })
    return post.id
  })
)
```

Scope operations:

| Scope | Operations |
| --- | --- |
| `ops.records` | `create`, `update`, `delete` |
| `ops.relationships` | `create`, `remove` |
| `ops.vectors` | `upsert`, `remove` |

Any failure inside the body (validation error, missing record, ...) aborts and
rolls back every mutation made so far:

```ts
// Nothing below persists — the create is rolled back when the lookup fails
yield* db.transaction((ops) =>
  Effect.gen(function* () {
    yield* ops.records.create({ data: { x: 1 } })
    return yield* ops.records.get("rec_does_not_exist_0000000001") // NotFoundError
  })
).pipe(Effect.ignore)
```

---

## 12. Bulk operations

Bulk APIs match individual-operation semantics exactly: every item goes
through the same tx-scoped mutation path, all inside one atomic transaction,
aborting on the first failure with no partial state.

```ts
const created = yield* db.bulk.createRecords([
  { data: { name: "B1" }, labels: ["Bulk"] },
  { data: { name: "B2" }, labels: ["Bulk"] }
])

const rels = yield* db.bulk.createRelationships([
  { type: "KNOWS", sourceId: created[0].id, targetId: created[1].id }
])

yield* db.bulk.upsertVectors([
  { recordId: created[0].id, namespace: "bulk", vector: [1, 0] },
  { recordId: created[1].id, namespace: "bulk", vector: [0, 1] }
])

const { deleted } = yield* db.bulk.deleteRecords([created[0].id, created[1].id])
```

---

## 13. Error handling

All failures use typed `CheguersError` subclasses (tagged `_tag`):

| Error | `_tag` | Typical cause |
| --- | --- | --- |
| `ValidationError` | `ValidationError` | bad input: invalid labels, ops, vectors, missing endpoints |
| `NotFoundError` | `NotFoundError` | record/relationship/vector ID does not exist |
| `ConflictError` | `ConflictError` | duplicate explicit record ID |
| `TransactionError` | `TransactionError` | transaction machinery failure |
| `DatabaseError` | `DatabaseError` | underlying Turso failure (open, read, write...) |

Pattern-match on `_tag`:

```ts
import { Exit } from "effect"

const exit = await Effect.runPromiseExit(db.records.get("rec_missing"))
if (Exit.isFailure(exit)) {
  const err = exit.cause.reasons?.[0]?.error
  if (err?._tag === "NotFoundError") {
    // handle missing record
  }
}
```

Or stay inside Effect and use `Effect.catchTag("NotFoundError", ...)` etc.

---

## 14. The CLI

`packages/cli` is a thin JSON-in/JSON-out transport over the public core API —
no SQL, no internal IDs, no duplicated logic. Run it via
`pnpm --filter @cheguers/cli cheguers` or `npx tsx packages/cli/src/cli.ts`.

Every command takes the database path first. Output is JSON on stdout; errors
are JSON on stderr with a non-zero exit code.

### Commands

```console
# Nested JSON -> graph, atomic (root must be a JSON object)
$ cheguers import app.db company.json --labels Company

# Bulk insert: file contains a JSON array of {data, labels}
$ cheguers bulk app.db people.json

# Fetch one record by ID
$ cheguers get app.db rec_983c1d56622946a894d3c80098628ef7

# Query with filters, ordering, pagination
$ cheguers query app.db --labels employees \
    --where '{"property":"age","op":"gte","value":40}' \
    --order age:desc --limit 10 --offset 0

# Graph traversal with provenance paths
$ cheguers traverse app.db --start <recordId> --direction outgoing \
    --types OWNS,HAS_TASK --min-depth 1 --max-depth 3 --limit 100 --paths

# Store a vector for a record
$ cheguers vec-upsert app.db <recordId> --vector 0.9,0.8,0.1 --namespace skills

# Exact vector search (optionally label/property pre-filtered)
$ cheguers vec-search app.db --vector 0.9,0.8,0.1 --metric cosine \
    --namespace skills --top-k 5 --labels employees \
    --where '{"property":"active","op":"eq","value":true}'

# Hybrid search (see section 10 for option semantics)
$ cheguers hybrid app.db --vector 0.9,0.8,0.1 --namespace skills \
    --labels employees --seeds 10 --expand-depth 2 --top-n 10 --provenance

# Inferred schema
$ cheguers schema app.db
$ cheguers schema app.db --label Person

# Database overview
$ cheguers stats app.db
```

Tip: vector searches are namespace-scoped. Vectors upserted with
`--namespace skills` are invisible to searches that omit `--namespace`.

### Scripted use

The CLI prints pure JSON, so it composes with `jq` / `python`:

```console
$ cheguers query app.db --labels employees | jq -r '.[].data.name'
$ cheguers hybrid app.db --vector 1,0,0 --expand-depth 1 --provenance \
    | jq -r '.[] | [.score, .record.data.name] | @tsv'
```

---

## 15. Rules the database enforces

These invariants hold everywhere; no API can bypass them.

1. Turso is the only durable source of truth; everything is in one file.
2. Public IDs (`rec_...`) are stable; internal integer IDs never leave the core.
3. Multi-table writes (record + labels + vectors + edges) are atomic.
4. Deleting a record removes its labels, vectors, and incident relationships.
5. Public queries never accept raw SQL; every user value is a parameter.
6. Traversal is bounded (max 3 hops) by validation, not convention.
7. Nested imports are all-or-nothing.
8. Vector search is exact — the correctness baseline for future ANN indexes.
9. Hybrid ranking is deterministic (stable ID tie-breaker).
10. Schema inference never modifies your JSON.
11. Failed mutations never expose partial state.

---

## 16. Development workflow

```console
$ pnpm install      # install workspace dependencies
$ pnpm typecheck    # tsc across all packages
$ pnpm lint         # eslint
$ pnpm test         # vitest: unit + integration + golden + property + differential
$ pnpm bench        # benchmark harness (graph / vector / hybrid / ingestion)
```


