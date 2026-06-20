#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${AGENT_WORKER_COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
ROLLBACK_IMAGE="${AGENT_WORKER_ROLLBACK_IMAGE:-}"
APPLY="${AGENT_WORKER_ROLLBACK_APPLY:-false}"

if [[ -z "$ROLLBACK_IMAGE" ]]; then
  echo "rollback_compose=failed reason=missing_AGENT_WORKER_ROLLBACK_IMAGE" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "rollback_compose=skipped reason=docker_not_found"
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "rollback_compose=skipped reason=docker_compose_not_found"
  exit 0
fi

export AGENT_WORKER_IMAGE="$ROLLBACK_IMAGE"
docker compose -f "$COMPOSE_FILE" config >/dev/null

if [[ "$APPLY" != "true" ]]; then
  echo "rollback_compose=dry_run image=$ROLLBACK_IMAGE"
  exit 0
fi

docker compose -f "$COMPOSE_FILE" pull agent-worker
docker compose -f "$COMPOSE_FILE" up -d agent-worker

echo "rollback_compose=applied image=$ROLLBACK_IMAGE"
