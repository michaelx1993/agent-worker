#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${AGENT_WORKER_IMAGE:-agent-worker:local}"
DOCKERFILE="${AGENT_WORKER_DOCKERFILE:-$ROOT_DIR/Dockerfile}"

if ! command -v docker >/dev/null 2>&1; then
  echo "release_image=skipped reason=docker_not_found"
  exit 0
fi

docker build \
  --file "$DOCKERFILE" \
  --tag "$IMAGE" \
  "$ROOT_DIR"

echo "release_image=passed image=$IMAGE"
