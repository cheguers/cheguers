#!/usr/bin/env bash
# Runs one benchmark arm of the CheguersDB × Terminal-Bench experiment.
#
#   bench/harbor/run.sh <arm> [extra harbor args...]
#
# Arms: baseline | cheguers | vector-only | notes
#
# Environment:
#   TB_TASKS_DIR   path to terminal-bench/tasks            (required)
#   MODEL          model for the agent, e.g. anthropic/claude-sonnet-4-5 (required)
#   AGENT          harbor agent                              (default: claude-code)
#   ATTEMPTS       attempts per task (-k)                    (default: 5)
#   CONCURRENCY    parallel trials (--n-concurrent)          (default: 2)
#   TASKS_FILE     task list, one name per line              (default: tasks/pilot.txt)
#   JOBS_DIR       where harbor writes results               (default: bench/results/jobs)
#   MCP_CONFIG     MCP config file                           (default: mcp/cheguers.mcp.json)
#   CHEGUERS_MCP_IMAGE  sidecar image                        (default: cheguers-mcp:latest)
#
# Auth: ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_FORCE_OAUTH=1
# for a subscription smoke test (see README).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARM="${1:-}"
shift || true

case "$ARM" in
  baseline | cheguers | vector-only | notes) ;;
  *)
    echo "usage: $0 <baseline|cheguers|vector-only|notes> [harbor args...]" >&2
    exit 2
    ;;
esac

: "${TB_TASKS_DIR:?set TB_TASKS_DIR to the terminal-bench tasks directory}"
: "${MODEL:?set MODEL, e.g. anthropic/claude-sonnet-4-5}"
AGENT="${AGENT:-claude-code}"
ATTEMPTS="${ATTEMPTS:-5}"
CONCURRENCY="${CONCURRENCY:-2}"
TASKS_FILE="${TASKS_FILE:-$HERE/tasks/pilot.txt}"
JOBS_DIR="${JOBS_DIR:-$HERE/../results/jobs}"
MCP_CONFIG="${MCP_CONFIG:-$HERE/mcp/cheguers.mcp.json}"
export CHEGUERS_MCP_IMAGE="${CHEGUERS_MCP_IMAGE:-cheguers-mcp:latest}"

task_args=()
while IFS= read -r line; do
  name="${line%%#*}"
  name="$(echo "$name" | tr -d '[:space:]')"
  [ -n "$name" ] && task_args+=(-i "$name")
done <"$TASKS_FILE"
if [ "${#task_args[@]}" -eq 0 ]; then
  echo "no tasks listed in $TASKS_FILE" >&2
  exit 2
fi

arm_args=()
if [ "$ARM" != "baseline" ]; then
  if ! docker image inspect "$CHEGUERS_MCP_IMAGE" >/dev/null 2>&1; then
    echo "sidecar image $CHEGUERS_MCP_IMAGE not found; build it first:" >&2
    echo "  docker build -f packages/mcp/Dockerfile -t $CHEGUERS_MCP_IMAGE ." >&2
    exit 1
  fi
  export CHEGUERS_BACKEND="$ARM"
  arm_args+=(
    --extra-docker-compose "$HERE/compose/cheguers-sidecar.yaml"
    --mcp-config "$MCP_CONFIG"
    --extra-instruction-path "$HERE/instructions/memory.md"
  )
fi

JOB_NAME="${JOB_NAME:-${ARM}-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$JOBS_DIR"

set -x
harbor run \
  -p "$TB_TASKS_DIR" \
  "${task_args[@]}" \
  --agent "$AGENT" \
  --model "$MODEL" \
  --env docker \
  -k "$ATTEMPTS" \
  --n-concurrent "$CONCURRENCY" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  "${arm_args[@]}" \
  "$@"
