#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="${AGENT_WORKER_RELEASE_COMPONENT:-agent-worker}"
COMMIT_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
SHORT_SHA="$(git -C "$ROOT_DIR" rev-parse --short "$COMMIT_SHA")"
TAG="${ACP_RELEASE_TAG:-${COMPONENT}-${SHORT_SHA}}"
IMAGE_REPOSITORY="${AGENT_WORKER_IMAGE_REPOSITORY:-ghcr.io/michaelx1993/agent-worker}"
IMAGE="${AGENT_WORKER_IMAGE:-${IMAGE_REPOSITORY}:${TAG}}"

case "$TAG" in
  *[[:space:]]* | "" | latest | stable | local)
    echo "release_tag=failed reason=invalid_tag tag=${TAG}" >&2
    exit 1
    ;;
esac

if [[ ! "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "release_tag=failed reason=tag_must_match_oci_and_git_safe_pattern tag=${TAG}" >&2
  exit 1
fi

if [[ "${ACP_CREATE_GIT_TAG:-false}" == "true" ]]; then
  if git -C "$ROOT_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
    echo "release_tag=failed reason=tag_already_exists tag=${TAG}" >&2
    exit 1
  fi
  git -C "$ROOT_DIR" tag -a "$TAG" -m "Release ${COMPONENT} ${TAG}" "$COMMIT_SHA"
  created=true
else
  created=false
fi

echo "release_tag=passed"
echo "component=${COMPONENT}"
echo "tag=${TAG}"
echo "commit=${COMMIT_SHA}"
echo "image=${IMAGE}"
echo "created=${created}"
