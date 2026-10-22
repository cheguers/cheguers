import json
from pathlib import Path

import pytest

ANSWER = Path("/app/answer.json")
GOLD = {
    row["qid"]: row["gold"]
    for row in (json.loads(line) for line in Path("/tests/gold.jsonl").read_text().splitlines() if line)
}


def load_answer():
    try:
        answer = json.loads(ANSWER.read_text())
    except Exception:
        return {}
    return answer if isinstance(answer, dict) else {}


def f1(pred, gold):
    pred = {x for x in pred if isinstance(x, str)} if isinstance(pred, list) else set()
    gold = set(gold)
    if not pred and not gold:
        return 1.0
    hit = len(pred & gold)
    if hit == 0:
        return 0.0
    precision = hit / len(pred)
    recall = hit / len(gold)
    return 2 * precision * recall / (precision + recall)


@pytest.mark.parametrize("qid", sorted(GOLD))
def test_answer(qid):
    score = f1(load_answer().get(qid), GOLD[qid])
    print("SCORE " + json.dumps({"qid": qid, "f1": round(score, 4)}))
    assert score == 1.0
