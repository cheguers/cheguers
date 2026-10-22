import json
import sqlite3
import struct
import sys
from pathlib import Path

store_dir, db_path = sys.argv[1], sys.argv[2]
corpus = [json.loads(line) for line in Path(store_dir, "corpus.jsonl").read_text().splitlines() if line]
edges = [json.loads(line) for line in Path(store_dir, "edges.jsonl").read_text().splitlines() if line]
vectors = {r["id"]: r["vector"] for r in (json.loads(line) for line in Path(store_dir, "vectors.jsonl").read_text().splitlines() if line)}

db = sqlite3.connect(db_path)
db.executescript(
    """
    DROP TABLE IF EXISTS records;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS vectors;
    CREATE TABLE records (id TEXT PRIMARY KEY, label TEXT, data TEXT);
    CREATE TABLE edges (id TEXT PRIMARY KEY, type TEXT, source_id TEXT, target_id TEXT);
    CREATE TABLE vectors (record_id TEXT PRIMARY KEY, dimensions INTEGER, vector BLOB);
    CREATE INDEX edges_source ON edges(source_id, type);
    CREATE INDEX edges_target ON edges(target_id, type);
    """
)
for r in corpus:
    data = dict(r["data"], text=r["text"])
    db.execute("INSERT INTO records VALUES (?, ?, ?)", (r["id"], r["labels"][0], json.dumps(data)))
    vec = vectors[r["id"]]
    db.execute("INSERT INTO vectors VALUES (?, ?, ?)", (r["id"], len(vec), struct.pack(f"<{len(vec)}f", *vec)))
for e in edges:
    db.execute("INSERT INTO edges VALUES (?, ?, ?, ?)", (e["id"], e["type"], e["from"], e["to"]))
db.commit()
db.close()
print(f"loaded {len(corpus)} records, {len(edges)} edges into {db_path}")
