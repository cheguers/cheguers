import json
import sys
from pathlib import Path

from fastembed import TextEmbedding

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CACHE = sys.argv[1]
model = TextEmbedding(model_name=MODEL, cache_dir=CACHE)


def rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


def write(path, items):
    with open(path, "w") as f:
        for item in items:
            f.write(json.dumps(item) + "\n")


for gen in sys.argv[2:]:
    gen = Path(gen)
    corpus = rows(gen / "corpus.jsonl")
    vectors = list(model.embed([r["text"] for r in corpus]))
    write(gen / "vectors.jsonl", [{"id": r["id"], "vector": [round(float(x), 6) for x in v]} for r, v in zip(corpus, vectors)])
    questions = rows(gen / "questions_public.jsonl")
    qv = list(model.embed([q["question"] for q in questions]))
    write(gen / "question_vectors.jsonl", [{"qid": q["qid"], "vector": [round(float(x), 6) for x in v]} for q, v in zip(questions, qv)])
    print(f"{gen}: {len(corpus)} corpus vectors, {len(questions)} question vectors")
