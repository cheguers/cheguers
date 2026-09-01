# CheguersDB — Implementation Plan

## 1. Goal

Build CheguersDB as an **embedded, TypeScript-first graph + vector database layer on top of Turso**.

CheguersDB owns:

- records and labels;
- relationships;
- arbitrary JSON properties;
- nested JSON → graph ingestion;
- schema inference;
- typed query DSL;
- query AST and SQL compiler;
- graph predicates and bounded traversal;
- vector persistence and exact similarity search;
- graph/metadata-filtered vector search;
- HybridRAG execution;
- transactions and bulk ingestion.

Turso owns:

- persistence;
- transactions;
- WAL/recovery;
- SQL execution;
- indexes;
- JSON functions;
- vector storage primitives and distance functions.

The first release is an embedded Node.js library using `@tursodatabase/database` and a local Turso database file.

### v0.1 must support

- open/create database;
- record CRUD;
- labels;
- typed relationships;
- nested JSON import;
- schema introspection;
- property filters;
- logical filters;
- related-record filters;
- bounded 1–3 hop traversal;
- vector upsert/delete;
- cosine and L2 exact search;
- graph/metadata-filtered vector search;
- vector → graph expansion → deterministic reranking;
- explicit transactions;
- bulk ingestion;
- persistence across reopen;
- reproducible tests and benchmarks.

---

# 2. Scope

## Build before v0.1

1. embedded core package;
2. Turso adapter;
3. migrations;
4. canonical relational model;
5. records and labels;
6. relationships;
7. nested JSON importer;
8. schema inference;
9. query DSL;
10. AST;
11. SQL compiler;
12. graph predicates;
13. bounded traversal;
14. vector search;
15. hybrid search;
16. transactions and bulk APIs;
17. tests;
18. benchmark harness;
19. benchmark-driven optimization;
20. v0.1 release.

## Do not build before v0.1

- custom WAL;
- custom pager/page cache;
- custom on-disk format;
- custom MVCC;
- custom recovery;
- custom B-tree;
- custom HNSW/IVF;
- sharding;
- distributed execution;
- cross-shard ACID;
- Cypher compatibility;
- cost-based optimizer;
- dashboard;
- cloud control plane;
- billing;
- enterprise authentication;
- LLM-driven relationship inference.

## After v0.1

1. CLI;
2. HTTP server;
3. MCP server;
4. embedding providers;
5. hosted/multi-tenant control plane;
6. property materialization if needed;
7. adjacency cache if needed;
8. CSR/CSR++ derived cache if needed;
9. ANN provider when available and justified.

---

# 3. Architecture

## 3.1 Runtime

Application → CheguersDB TypeScript API → domain/query layer → Turso adapter → embedded Turso → database file

There is no required Neo4j instance, vector database, or database server in v0.x.

## 3.2 Layers

### Public API

Responsibilities:

- database lifecycle;
- records;
- relationships;
- imports;
- schema introspection;
- queries;
- vector search;
- hybrid search;
- transactions;
- public errors.

The public API must not expose SQL, Turso-specific result types, or internal integer IDs.

### Domain layer

Responsibilities:

- record model;
- label model;
- relationship model;
- vector model;
- IDs;
- validation;
- mutation normalization;
- nested JSON normalization;
- schema inference.

### Query layer

Pipeline:

Public DSL → validation → AST → planning → parameterized SQL → execution → result shaping

Responsibilities:

- property predicates;
- logical expressions;
- label predicates;
- relationship predicates;
- traversal;
- vector search;
- hybrid planning;
- ordering;
- pagination;
- deterministic result ordering.

### Database adapter

Responsibilities:

- database open/close;
- transactions;
- migrations;
- parameterized statements;
- capability detection;
- query-plan inspection;
- Turso error translation.

Only the adapter may depend directly on `@tursodatabase/database`.

### Turso

Turso remains the only durable source of truth.

---

# 4. Repository structure

Use a pnpm workspace.

## `packages/core`

### Root

- database facade;
- configuration;
- errors;
- public exports.

### `database`

- adapter contract;
- Turso adapter;
- migrations;
- capabilities;
- metadata.

### `domain`

- record;
- label;
- relationship;
- vector;
- IDs;
- property/value types.

### `records`

- record service;
- repository;
- validation;
- mutation logic;
- nested importer;
- normalizer.

### `relationships`

- relationship service;
- repository;
- traversal service.

### `schema`

- inference;
- catalog repository;
- introspection service.

### `query`

- public query types;
- AST;
- parser;
- compiler;
- executor;
- result shaping.

Compiler components:

- properties;
- labels;
- logical expressions;
- relationships;
- traversal;
- vector clauses;
- ordering;
- pagination.

### `vector`

- vector repository;
- exact search provider;
- metric handling;
- future index-provider abstraction.

### `hybrid`

- planner;
- seed retrieval;
- graph expansion;
- reranking;
- provenance/result shaping.

## `packages/benchmark`

- synthetic dataset generation;
- graph benchmarks;
- vector benchmarks;
- hybrid benchmarks;
- ingestion benchmarks.

## Later

- `packages/cli`;
- `packages/server`;
- `packages/mcp-server`.

---

# 5. Canonical data model

## Records

Fields:

- internal integer ID;
- public stable string ID;
- JSON data;
- created timestamp;
- updated timestamp.

Rules:

- public APIs use only public IDs;
- internal IDs are used only for joins/indexes;
- JSON is the canonical property representation in v0.1.

## Labels

Use normalized labels and a record-label mapping.

Requirements:

- multiple labels per record;
- indexed lookup by label;
- indexed lookup of labels by record.

## Relationships

Use one canonical edge table.

Fields:

- internal ID;
- public ID;
- source record;
- target record;
- relationship type;
- optional JSON properties;
- created timestamp.

Required indexes:

- source;
- target;
- source + type;
- target + type.

The edge table is the canonical graph representation.

## Vectors

Store vectors separately from record JSON.

Fields:

- record ID;
- vector property/namespace;
- dimensions;
- vector BLOB;
- updated timestamp.

Requirements:

- multiple named vectors per record;
- dimension validation;
- canonical vectors remain independent from future ANN indexes.

## Schema catalog

Track:

- label;
- property;
- inferred type;
- observation count;
- first seen;
- last seen.

Initial types:

- string;
- number;
- boolean;
- null;
- datetime where explicitly recognized.

The catalog is metadata only. User JSON remains canonical.

---

# 6. Write architecture

All writes pass through a normalized mutation boundary before Turso.

Mutation types:

- create/update/delete record;
- add/remove label;
- create/delete relationship;
- upsert/delete vector;
- bulk import.

Before execution:

1. validate input;
2. resolve IDs;
3. normalize values;
4. calculate graph changes;
5. calculate schema-catalog changes;
6. reject invalid operations;
7. execute atomically when multiple tables are involved.

Use transactions for:

- record + labels;
- nested imports;
- bulk writes;
- record + vector operations exposed as one logical write;
- deletes involving dependent data;
- schema-catalog changes associated with mutations.

Deletion semantics for v0.1:

- deleting a relationship affects only that relationship;
- deleting a vector affects only that vector;
- deleting a record removes its labels, vectors, and incident relationships atomically.

---

# 7. Nested JSON ingestion

Nested JSON must be normalized before persistence.

Normalization rules:

- scalars become current-record properties;
- nested objects may become child records;
- arrays of objects become multiple related records;
- scalar arrays remain properties initially;
- relationship type derives deterministically from the nesting key;
- generated IDs are stable for the duration of the import;
- one logical import is atomic.

Normalizer output:

- records;
- labels;
- relationships;
- schema changes.

The normalizer must not depend on Turso.

---

# 8. Query architecture

## Query DSL

v0.1 operators:

### Comparisons

- equals;
- not equals;
- greater than;
- greater than or equal;
- less than;
- less than or equal;
- in;
- not in;
- contains;
- starts with;
- ends with;
- exists.

### Logical

- AND;
- OR;
- NOT.

### Record constraints

- public ID;
- labels;
- properties;
- related records;
- ordering;
- pagination.

### Relationship constraints

- relationship type;
- direction;
- related-record predicates;
- bounded hops.

### Vector constraints

- vector namespace;
- query vector;
- metric;
- top-k;
- optional distance threshold;
- metadata/graph filters.

## Compilation pipeline

1. validate public input;
2. parse DSL;
3. create normalized AST;
4. determine query shape;
5. compile parameterized SQL;
6. execute;
7. shape results;
8. apply deterministic tie-breaking.

## Compiler invariants

- all user values are parameters;
- raw SQL is never accepted from public queries;
- identifier-like inputs are validated;
- equivalent ASTs produce stable SQL/parameter ordering;
- relationship predicates use indexed subqueries/EXISTS where appropriate;
- restrictive filters execute before vector distance whenever possible;
- compiler output is covered by golden tests.

---

# 9. Graph architecture

## Relationship predicates

One-hop related-record filters use the canonical edge table with indexed source/target/type lookups.

They must compose with:

- labels;
- properties;
- logical operators;
- other nested related-record filters.

## Bounded traversal

v0.1 supports 1–3 hops.

Required controls:

- start records;
- direction;
- relationship types;
- min depth;
- max depth;
- max results/fanout.

### Initial implementation

Use indexed iterative BFS with batched edge queries.

Maintain:

- current frontier;
- visited set;
- depth;
- discovered nodes;
- optional provenance/path metadata.

### Alternative implementation

Implement recursive CTE traversal only after BFS is correct.

Compare both using the same public traversal contract and differential tests.

### Future graph optimization

Optimization order:

1. indexes;
2. batching;
3. recursive CTE comparison;
4. adjacency cache;
5. CSR cache;
6. CSR++ only if dynamic cache-update cost requires it.

The edge table always remains canonical.

---

# 10. Vector architecture

## v0.1

Use exact vector search through Turso vector functions.

Metrics:

- cosine;
- L2.

Exact search is the correctness baseline.

## Filter-first execution

When possible:

labels/properties/graph predicates → candidate vectors → distance calculation → top-k

Do not calculate vector distance over the full dataset when a selective graph or metadata filter is available.

## Future vector index

Define a provider boundary now, but implement only exact search in v0.1.

Future provider capabilities:

- create/rebuild index;
- search;
- report capabilities;
- report freshness/version if applicable;
- fall back to exact search.

---

# 11. HybridRAG architecture

Support two query modes.

## Mode A — filter → vector

Execution:

1. labels;
2. properties;
3. relationship filters;
4. qualifying vectors;
5. vector distance;
6. top-k.

Implement this first.

## Mode B — vector → graph → rerank

Execution:

1. vector top-k seeds;
2. bounded graph expansion;
3. candidate aggregation;
4. deterministic reranking;
5. final top-n.

Initial reranking signals:

- vector score;
- graph depth;
- number of seed paths;
- optional relationship-type weight;
- stable ID tie-breaker.

Optional provenance:

- seed record;
- vector score;
- graph depth;
- relationship path/summary;
- final score.

Do not add an LLM reranker to the v0.1 core.

---

# 12. Core invariants

1. Turso is the durable source of truth.
2. Edge table is canonical graph storage.
3. Vector table is canonical vector storage.
4. Derived caches/indexes are rebuildable.
5. Public IDs are stable.
6. Internal IDs never leave the core.
7. Multi-table writes are atomic.
8. Public queries never accept raw SQL.
9. User values are always parameterized.
10. Traversal is explicitly bounded.
11. Exact vector search defines future ANN correctness.
12. Hybrid ranking is deterministic.
13. Nested imports are all-or-nothing.
14. Schema inference never modifies canonical user JSON.
15. Failed mutations cannot expose partial state.

---

# 13. Testing plan

## Unit tests

Cover:

- normalization;
- validation;
- schema inference;
- query parser;
- AST normalization;
- compiler components;
- traversal bookkeeping;
- reranking;
- result shaping.

## Compiler golden tests

For each query form verify:

- AST;
- SQL shape;
- parameters;
- parameter order;
- no interpolated user values.

## Integration tests

Use a real temporary Turso database.

Cover:

- migrations;
- CRUD;
- labels;
- relationships;
- imports;
- schema;
- filters;
- graph predicates;
- traversal;
- vectors;
- hybrid queries;
- transactions;
- close/reopen.

## Differential tests

Compare:

- BFS vs recursive CTE;
- optimized vs reference queries;
- future ANN vs exact search;
- future materialized properties vs JSON queries.

---

# 14. Benchmark plan

Benchmarks exist to decide optimizations, not as a separate research deliverable.

Measure:

### Ingestion

- records/sec;
- relationships/sec;
- bulk import throughput.

### Graph

- 1-hop latency;
- 2-hop latency;
- 3-hop latency;
- fanout sensitivity;
- BFS vs recursive CTE.

### Vector

- cosine latency;
- L2 latency;
- effect of vector dimensions;
- effect of candidate-set size;
- benefit from graph/metadata pre-filtering.

### Hybrid

- filter → vector latency;
- vector → graph latency;
- reranking overhead;
- end-to-end p50/p95/p99.

### Resources

- database size;
- process RSS;
- traversal memory;
- vector-search memory.

Every benchmark records environment, dataset seed, dataset size, graph fanout, vector dimensions, warmup, and repetition count.

---

# 15. Implementation roadmap

## Phase 0 — Repository

Build:

- pnpm workspace;
- TypeScript configuration;
- formatting/linting;
- Vitest;
- core package;
- benchmark package;
- CI.

Done when install, type-check, lint, and test all succeed from a clean checkout.

## Phase 1 — Turso foundation

Build:

- adapter contract;
- Turso adapter;
- open/close;
- transactions;
- migrations;
- metadata/versioning;
- capability checks.

Done when a DB can be created, migrated, reopened, committed, and rolled back.

## Phase 2 — Canonical schema

Build:

- records;
- labels;
- record-label mapping;
- relationships;
- vectors;
- schema catalog;
- indexes;
- ID strategy.

Done when all canonical entities persist correctly across reopen.

## Phase 3 — Records and labels

Build CRUD, label operations, validation, delete semantics, and bulk-record foundations.

Done when CRUD and labels are atomic and fully integration-tested.

## Phase 4 — Relationships

Build create/delete/read, incoming/outgoing lookup, type filters, and relationship properties.

Done when indexes and referential integrity are verified.

## Phase 5 — Nested import

Build the database-independent normalizer and transactional importer.

Done when nested fixtures produce deterministic records/edges and partial imports cannot occur.

## Phase 6 — Schema inference

Build type inference, catalog updates, and introspection API.

Done when catalog metadata matches canonical records and conflicting types are handled consistently.

## Phase 7 — Query DSL and AST

Build public query types, parser, validation, normalized AST, ordering, and pagination.

Done when representative queries produce stable ASTs and invalid queries fail before compilation.

## Phase 8 — SQL compiler

Build property, label, logical, ordering, pagination, execution, and result shaping.

Done when all scalar filters pass integration tests and compiler golden tests.

## Phase 9 — Relationship predicates

Build related-record AST nodes and SQL compilation.

Done when nested graph filters compose correctly with labels/properties/logical predicates.

## Phase 10 — Traversal

Build bounded BFS, cycle handling, direction/type filters, limits, instrumentation, and recursive CTE comparison.

Done when depth 1–3 is correct and BFS/CTE results match.

## Phase 11 — Vector search

Build vector persistence, dimension validation, cosine, L2, namespaces, and exact search provider.

Done when results match reference calculations and persist across reopen.

## Phase 12 — Filtered vector search

Combine metadata/graph predicates with vector search and push filtering before distance evaluation.

Done when one query API can combine labels, properties, relationships, and vector ranking correctly.

## Phase 13 — HybridRAG

Build vector seed retrieval, graph expansion, candidate aggregation, deterministic reranking, provenance, and instrumentation.

Done when vector → graph → rerank works end-to-end for 1–3 hops.

## Phase 14 — Transactions and bulk APIs

Build explicit transaction API and bulk record/relationship/vector operations.

Done when rollback is correct across every mutation type and bulk operations match individual-operation semantics.

## Phase 15 — Optimization

Optimize only from benchmark evidence.

Order:

1. indexes/query plans;
2. N+1 removal;
3. batching;
4. JSON hot-path reduction;
5. BFS vs CTE default selection;
6. TypeScript allocation reduction;
7. property materialization if needed;
8. adjacency cache if needed;
9. CSR/CSR++ if needed;
10. ANN if available and needed.

Every optimization requires a before/after benchmark and correctness comparison.

## Phase 16 — v0.1 release

Release only when all core features, tests, persistence checks, and benchmark commands are stable.

---

# 16. v0.1 release gate

Required:

- clean type-check;
- clean lint;
- unit tests green;
- integration tests green;
- compiler golden tests green;
- property-based tests for parser/normalizer;
- persistence/reopen tests green;
- graph/vector/hybrid benchmarks runnable from clean checkout;
- no Turso internals in public API;
- no raw SQL path in public query API;
- exact vector search available as correctness baseline;
- traversal bounded by default;
- deterministic hybrid ordering;
- documented supported API surface.

---

# 17. Post-v0.1

## CLI

Thin wrapper around core for:

- import;
- query;
- traversal;
- vector search;
- hybrid search;
- schema inspection;
- database inspection.

## HTTP server

Thin transport over core.

Do not duplicate domain or query logic.

## MCP server

Expose stable core operations for agent memory and retrieval.

## Hosted control plane

Add only after the embedded core is stable.

Expected responsibilities:

- tenant/database routing;
- authentication;
- quotas;
- replicas;
- backups;
- metrics;
- usage accounting;
- deployment lifecycle.

---

# 18. Final implementation order

1. repository/CI;
2. Turso adapter;
3. migrations;
4. canonical schema;
5. records/labels;
6. relationships;
7. nested import;
8. schema inference;
9. query DSL;
10. AST;
11. SQL compiler;
12. relationship predicates;
13. bounded traversal;
14. vector persistence;
15. exact vector search;
16. filtered vector search;
17. HybridRAG;
18. transactions/bulk APIs;
19. benchmarks;
20. optimization;
21. v0.1;
22. CLI;
23. HTTP server;
24. MCP server;
25. embedding providers;
26. hosted control plane;
27. derived caches/ANN only when benchmarks justify them.
