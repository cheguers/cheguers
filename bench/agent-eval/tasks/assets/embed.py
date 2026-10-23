import os
import sys

from fastembed import TextEmbedding

CACHE = os.environ.get("FASTEMBED_CACHE", "/opt/fastembed-cache")
model = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2", cache_dir=CACHE)

if __name__ == "__main__":
    vector = next(model.embed([" ".join(sys.argv[1:])])).tolist()
    print(",".join(f"{x:.6f}" for x in vector))
