#!/bin/sh
# Runs the full agent evaluation: calibration arms, then three repeats of the four main arms.
# Usage: CLAUDE_CODE_OAUTH_TOKEN=... run-study.sh <work-dir> <tasks-dir>
# <tasks-dir> is the output of tasks/build-tasks.mjs; <work-dir> receives tb-runs/ and status files.
set -eu
WORK=${1:?work dir}
TASKS=${2:?tasks dir}
AGENTS=$(cd "$(dirname "$0")/../agents" && pwd)
: "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN (Claude subscription token)}"
export CLAUDE_CODE_OAUTH_TOKEN PYTHONPATH="$AGENTS" ARM_MAX_TURNS="${ARM_MAX_TURNS:-12}"
CONCURRENCY="${CONCURRENCY:-2}"
MODEL=claude-haiku-5-5
cd "$WORK"

ids() {
  for s in 1 2 3 4 5 6; do for st in hop0 hop1 hop2 hop3 filter; do printf -- "--task-id kb-s%s-%s%s " "$s" "$st" "$1"; done; done
}
tb_run() {
  dataset_suffix=$1; agent=$2; run_id=$3
  tb run --dataset-path "$TASKS" $(ids "$dataset_suffix") --agent-import-path "$agent" -m "$MODEL" \
    --output-path tb-runs --run-id "$run_id" --n-concurrent "$CONCURRENCY"
}

tb_run -closed arms_agent:ClosedBookAgent calib-closed-book
tb_run -gold arms_agent:GoldContextAgent calib-gold-context
for r in "" r2 r3; do
  prefix=full${r:+-$r}
  tb_run -files arms_agent:FilesAgent "$prefix-files"
  tb_run "" arms_agent:Sqlite3Agent "$prefix-sqlite3"
  tb_run "" arms_agent:CheguersFullAgent "$prefix-cheguers-full"
  tb_run "" arms_agent:CheguersVectorAgent "$prefix-cheguers-vector"
done
echo DONE > study-status.txt
