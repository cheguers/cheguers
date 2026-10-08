## Memory tools

You have a persistent memory server available through the `memory` MCP tools
(`memory_store`, `memory_ingest`, `memory_search`, `memory_get`, `memory_link`,
`memory_neighbors`, `memory_stats`). It starts empty for this task.

Use it when it helps you: index large or numerous files you will need to
consult repeatedly with `memory_ingest` (send the file contents), record facts,
constraints and decisions with `memory_store`, and look things up with
`memory_search` instead of re-reading everything. The memory server is only
available while you work: your final solution must not depend on it.
