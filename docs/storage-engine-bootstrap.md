# CheguersDB Storage Engine Bootstrap

## Human notes

This document is the starting point for CheguersDB's storage engine work.

This was written by GPT 5.4 xhigh after a throrough back and forth conversation about all of this stuff. It summarizes very well my throughts on the v0 implementation.

It is intentionally very opinionated. The project is too broad to begin from "graph + vector + distributed + analytics (if we are to) + flexible consistency" all at once. I believe that the first job is to remove a lot of the scope until the core system is buildable, and more important, we should focus on proving that the core system is reasonable. That means a literal MVP. This document has a big focus on removing unnecessary MVP concerns.

## 1. What CheguersDB Should Be First

The first version should be:

- A distributed serving database for graph traversal plus vector-assisted retrieval.
- Strongly consistent within a shard-group.
- Append-oriented and recovery-first.
- Optimized for point reads, bounded neighbor expansion, and ANN candidate lookup.

The first version should not be:

- A full HTAP system.
- A general multi-model database.
- Cross-shard ACID.
- A system with user-visible consistency knobs beyond a single safe default.
- A system that tries to maintain multiple independent storage representations for the same data.

## 2. Recommendation

Do not start by building "a custom distributed graph-vector database".

Start by building:

1. A single-shard replicated state machine.
2. A custom local storage engine for one shard.
3. A graph-serving execution path with vector sidecar indexing.
4. Shard routing only after the single-shard contract is stable.

This means:

- TigerBeetle is the reference for replication boundary and deterministic execution.
- Kuzu is the reference for graph-specific physical layout and separation between logical graph semantics and on-disk organization.
- Neo4j is a major reference for traversal-locality-first graph storage and index-free adjacency style design.
- Helix is mostly a negative reference for CheguersDB storage: it is useful for product shape and query ergonomics, but not for the core local engine, because LMDB/KV composition keeps the dependent-lookup problem alive.

## 3. The Core Bet

The local shard engine should use a graph-native physical layout, not a generic KV store.

Reasoning:

- Your dominant hard path is not "lookup one key". It is "start from seed set, expand adjacency, fetch neighbor metadata, optionally rerank with vector relevance".
- Kuzu's source shows why graph systems move toward CSR/node-group style structures rather than plain KV composition.
- TigerBeetle shows why the commit boundary must be owned by the database, not outsourced to a storage engine with its own flush model.
- Helix's LMDB layout is simpler to build, but it still pays lookup and indirection costs at traversal time.

That does not mean you should copy Neo4j's exact fixed-record store.

The current bias is:

- closer to Neo4j in read-path priorities and traversal locality goals,
- closer to Kuzu in implementation structure and storage discipline.

In practice, that means a graph-native serving layout with strong locality, but still using a structured page/segment design rather than raw physical pointers everywhere on disk.

The better starting point is:

- Pointer-like locality for hot adjacency access.
- Page- and segment-based storage for maintainability and recovery.
- Immutable or append-only data regions where possible.
- Explicit background rebuild paths for derived indexes.

## 4. Recommended v0 Scope

### Data model

Support only:

- `Node`
- `Edge`
- `Vector`

With hard limits for v0:

- Fixed schema per label or type.
- Fixed vector dimension per vector index.
- Single primary key per entity type.
- Small bounded property set, typed at schema definition time.

### Consistency contract

Default SDK behavior:

- Linearizable writes and reads within a shard-group leader.
- ANN search is not part of the linearizable contract.
- ANN returns candidates from an index that may lag the committed graph by a bounded amount.
- Final graph/property fetch after ANN candidate generation must read from committed state.

This gives you one clean default:

- "Committed graph truth, possibly stale ANN candidate generation."

Expose no user knobs for this in v0 except maybe:

- `ann_max_staleness_ms`

If you cannot enforce that bound yet, do not expose the knob.

### Transactions

Support only:

- Single-shard write transactions.
- Single-shard read transactions.
- Single-shard ACID.

Do not support:

- Cross-shard ACID.
- Distributed graph mutations touching multiple shard-groups atomically.

Cross-shard behavior in v0 should be:

- Best-effort fanout reads.
- Client-visible partial failure.
- Application-managed sagas for multi-shard writes.

## 5. Physical Design Recommendation

Use three storage layers inside a shard:

### 5.1 Commit log

Purpose:

- Durability.
- Replication input/output.
- Recovery source.

Properties:

- Ordered command log.
- Checksummed.
- Segment-based.
- Source of truth for replay into local structures.

This follows the TigerBeetle mindset: the replicated log is the authoritative ordered input to the state machine.

### 5.2 Base graph store

Purpose:

- Canonical committed graph state.

Recommended structure:

- Page-based object store for node and edge records.
- Separate adjacency structure keyed by source node group and edge type.
- Dense adjacency pages laid out for sequential scans.
- Property columns or property blocks separated from adjacency metadata.

Suggested layout:

- `node_heap`: node headers and fixed metadata.
- `edge_heap`: edge records with source, destination, type, version, tombstone.
- `adjacency_index`: maps `(node_id, edge_type, direction)` to adjacency segment references.
- `adjacency_segments`: packed neighbor lists or CSR-like ranges.
- `property_store`: typed property columns or blocks by label/type.
- `catalog`: schema, type IDs, index metadata, format version.

Important choice:

- Use logical IDs everywhere.
- Avoid raw physical pointers across pages on disk in v0.
- Physical references should be stable page/slot IDs, not naked memory-style pointers.

That gets you most of the locality benefit without making compaction and repair a nightmare.

### 5.3 Derived vector index

Purpose:

- Fast ANN candidate generation.

Recommended structure:

- Separate index file family from base graph store.
- Rebuildable from committed vectors in the base store.
- Logically attached to a snapshot/version watermark.

For v0:

- Start with brute-force exact KNN for correctness tests.
- Add HNSW only after snapshot/versioning and rebuild logic are clear.

This matters because ANN freshness is one of your biggest semantic risks. Treat ANN as a derived index, not as the canonical store of vector truth.

## 6. Why Not Copy Each Reference Directly

### HelixDB

Useful for:

- Product framing around graph plus vector.
- End-to-end ergonomics.
- Quick experimentation.

Not a model for Cheguers local storage because:

- It composes graph structures over LMDB databases.
- Traversal still depends on index/key lookups.
- It does not give you clean ownership of storage-level commit semantics for distributed replication.

Local files:

- `helix-db/helix-db/src/helix_engine/storage_core/mod.rs`
- `helix-db/helix-db/src/helix_engine/vector_core/vector_core.rs`
- `helix-db/helix-db/src/helix_engine/traversal_core/ops/out/out.rs`

### Kuzu

Useful for:

- Graph-specific storage layout.
- CSR and node-group organization.
- Separation between transactional updates and checkpointed persistent structures.

Why it matters:

- Its relationship storage is clearly not "just put edges in a map".
- It has explicit CSR node groups, checkpoint logic, WAL, and shadow-page mechanisms.

Local files:

- `kuzu/src/include/storage/table/csr_node_group.h`
- `kuzu/src/include/storage/table/rel_table.h`
- `kuzu/src/include/storage/table/rel_table_data.h`
- `kuzu/src/include/storage/wal/wal.h`
- `kuzu/src/storage/shadow_file.cpp`

### TigerBeetle

Useful for:

- Replication boundary.
- Consensus and commit ordering.
- Deterministic state machine architecture.
- Owning the durability semantics.
- Single binary, single replica file discipline.

Why it matters:

- It treats consensus and storage as one coherent system.
- The database decides what committed means.
- The log drives the state machine, not the other way around.

Local files:

- `tigerbeetle/src/state_machine.zig`
- `tigerbeetle/src/storage.zig`
- `tigerbeetle/src/vsr.zig`
- `tigerbeetle/docs/coding/system-architecture.md`
- `tigerbeetle/docs/operating/cluster.md`

## 7. First Architecture Decisions To Lock Now

These should be written as ADRs next.

### ADR-1: Single safe default consistency contract

Decision:

- All writes are linearizable within a shard-group.
- Graph/property reads are linearizable from the shard leader.
- ANN candidate generation is snapshot-bounded but may lag.
- Final object hydration after ANN is from committed graph state.

### ADR-2: No cross-shard ACID in v0

Decision:

- Cross-shard reads are scatter-gather.
- Cross-shard writes are sagas or deferred.

### ADR-3: Shard-group ownership

Decision:

- A shard-group owns a disjoint subset of entity IDs.
- Edges crossing shard-groups are allowed but first-class local traversal is only guaranteed for local source ownership.

Practical implication:

- Shard by source node ownership first.
- Remote edge traversal becomes an explicit network hop.

### ADR-4: Analytics deferred

Decision:

- No separate analytics engine in v0.
- Export snapshots or CDC later rather than maintaining a second materialized execution path now.

## 8. Concrete v0 Storage Model

If I were starting Cheguers this week, I would build this exact path:

### Phase 0: correctness-only local store

- Single process.
- No replication.
- Append-only command log.
- In-memory adjacency map rebuilt from log on startup.
- Disk-backed object heap for nodes, edges, vectors.
- Exact vector scan only.

Goal:

- Lock the command model and recovery semantics before optimizing anything.

### Phase 1: single-shard durable engine

- Segment log with checksums and replay.
- Page-based graph store.
- Adjacency segments for out-neighbors.
- Simple free-space tracking.
- Snapshots plus recovery tests.

Goal:

- A shard can recover exactly from crash/replay.

### Phase 2: consensus and deterministic replicated shard-group

- Replicated log.
- Leader/follower.
- State machine applies commands deterministically.
- Read policy: leader only.

Goal:

- Prove commit semantics before sharding.

### Phase 3: vector indexing as derived state

- Build HNSW from committed vector records.
- Attach build progress to snapshot/version.
- Allow background catch-up.
- Enforce freshness reporting.

Goal:

- ANN is fast without contaminating the base consistency model.

### Phase 4: sharding

- Route by source node ownership.
- Keep edges local where possible.
- Add remote traversal operators explicitly.

Goal:

- Scale out the serving path without pretending cross-shard traversal is free.

## 9. First Milestones

### Milestone A: storage contract

Implement:

- Command types: `CreateNode`, `CreateEdge`, `UpsertVector`, `Delete*`
- Binary log format
- Replay
- Snapshot metadata
- Basic corruption checks

Success criteria:

- Crash at arbitrary points and recover to a valid committed prefix.

### Milestone B: graph read path

Implement:

- Node lookup by ID
- Out-neighbor scan by edge type
- Simple multi-hop bounded traversal

Success criteria:

- Traversal results are deterministic across replay and restart.

### Milestone C: vector correctness path

Implement:

- Vector record storage
- Exact KNN
- Candidate-to-graph hydration

Success criteria:

- Correct results before ANN exists.

### Milestone D: replication

Implement:

- Leader append
- Follower replication
- Commit index
- Apply loop

Success criteria:

- Followers replay identical state from the same command stream.

## 10. Project Structure Suggestion

Suggested Rust crate layout:

- `cheguers-log`: command log, checksums, segments, replay.
- `cheguers-store`: page store, object heap, adjacency segments, catalog.
- `cheguers-state-machine`: deterministic command application.
- `cheguers-vector`: exact KNN first, HNSW later.
- `cheguers-repl`: replication protocol and shard-group membership.
- `cheguers-query`: serving operators over local shard state.

Do not start with a query language. Start with a typed internal command/query API.

## 11. Hard Questions With Recommended Defaults

### What is the default consistency contract?

Recommended:

- Linearizable local graph reads and writes.
- Snapshot-bounded ANN candidates.

### What ANN staleness is acceptable?

Recommended initial contract:

- Return actual freshness metadata with every ANN response.
- Internally target sub-second lag, but do not promise a number until you can measure it.

### What are the cross-shard atomicity requirements?

Recommended answer for v0:

- None.

If a product requirement appears that truly needs it, reevaluate only then.

### What is the primary sharding strategy?

Recommended priority:

1. Source-node graph locality.
2. Tenant isolation.
3. Vector locality.

Reason:

- Traversal cost dominates serving pain first.
- Tenant isolation can be layered with placement rules.
- Vector locality matters, but ANN candidate fetch plus graph follow-up is still graph-shaped.

### Business priority: serving or analytics?

Recommended:

- Serving latency and throughput.

If analytics matters later, export snapshots or CDC into a different system before building a second engine inside Cheguers.

## 12. What To Build Next In This Repo

Immediate next artifacts:

1. `ADR-0001`: consistency contract
2. `ADR-0002`: no cross-shard ACID in v0
3. `ADR-0003`: shard by source-node ownership
4. `docs/command-model.md`: binary command model
5. `docs/on-disk-layout-v0.md`: segment/page/object layout
6. `docs/recovery-invariants.md`: crash and replay invariants

Then start code in this order:

1. Log format and replay tests.
2. Local store with deterministic apply.
3. Basic traversal operators.
4. Exact vector scan.
5. Replication.

## 13. External References

These were the most relevant primary sources for the recommendations above:

- TigerBeetle system architecture: https://docs.tigerbeetle.com/coding/system-architecture/
- TigerBeetle cluster model: https://docs.tigerbeetle.com/operating/cluster/
- Kuzu CIDR paper: https://www.cidrdb.org/cidr2023/papers/p104-lamb.pdf
- HNSW paper listing: https://pubmed.ncbi.nlm.nih.gov/30602420/

## 14. Bottom Line

The right first step is not to choose between Neo4j, Kuzu, Helix, and TigerBeetle.

The right first step is to combine:

- TigerBeetle's ownership of commit semantics,
- Kuzu's willingness to use graph-native physical structures,
- and a much smaller v0 than the current full vision.

If Cheguers tries to ship distributed graph + vector + analytics + flexible consistency from day one, it will stall.

If it ships a replicated shard-local serving engine with one safe default contract, it can grow.
