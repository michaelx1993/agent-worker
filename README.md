# Agent Worker

Distributed Worker daemon for Agent Control Plane.

This repository contains the production HTTP Worker path only. The worker does not connect to PostgreSQL and does not hold Plane API keys. It talks to Agent Control Plane through the Worker API:

- `POST /api/worker/v1/register`
- `POST /api/worker/v1/runs/claim`
- `POST /api/worker/v1/runs/:runId/heartbeat`
- `POST /api/worker/v1/runs/:runId/events`
- `POST /api/worker/v1/runs/:runId/progress`
- `POST /api/worker/v1/runs/:runId/artifacts`
- `POST /api/worker/v1/runs/:runId/complete`
- `POST /api/worker/v1/runs/:runId/fail`

Terminal lifecycle writes are final: once `complete` or `fail` succeeds, the run lease is no longer active for additional Worker writes. The worker must write the final Progress entry before calling `complete` or `fail`.

Worker claim responses may include `planeRuntimeSnapshot`. When present, the worker treats that snapshot as the frozen runtime context and prefers its repository, prompt, previous conversation and workspace metadata over legacy compatibility fields on `run` / `promptRelease`. The legacy fields remain supported so older Control Plane versions can still run.

When the snapshot includes a Plane Project Workspace id, successful runs also write Project Meta Git under `WORKER_WORKSPACE_ROOT/_project-meta/<project>`. The worker rewrites `status.md`, appends `progress.md`, writes `runs/<run_id>.md` and appends `artifacts/index.md`, commits those files locally, then reports the commit evidence through `/artifacts` as `projectMetaGit`.

## Development

```bash
pnpm install
pnpm format
pnpm typecheck
pnpm test
pnpm worker:contract-smoke
pnpm build
pnpm codex:adapter-smoke
pnpm codex:app-server-smoke
pnpm worker:workspace-smoke
pnpm workspace:cleanup-smoke
pnpm compose:smoke
ACP_RELEASE_TAG=agent-worker-ci-smoke pnpm release:tag
pnpm release:image
AGENT_WORKER_DEPLOY_IMAGE=agent-worker:deploy-smoke pnpm deploy:compose
AGENT_WORKER_ROLLBACK_IMAGE=agent-worker:previous pnpm rollback:compose
```

## Run

```bash
cp .env.example .env
pnpm --filter @agent-control-plane/worker dev
```

Required runtime variables:

- `CONTROL_PLANE_BASE_URL`
- `ACP_WORKER_API_TOKEN`
- `WORKER_ID`
- `WORKER_EXECUTION_ADAPTER=codex-cli` or `codex-app-server`
- `WORKER_WORKSPACE_ROOT`
- `WORKER_WORKSPACE_STRATEGY=local-path`, `ephemeral`, or `git-worktree`

## Docker

```bash
docker build -t agent-worker:local .
docker run --env-file .env agent-worker:local
```

Compose smoke validates the production service definition without starting the worker:

```bash
pnpm compose:smoke
```

Build the release image with the default local tag:

```bash
pnpm release:image
```

Validate the unified release tag metadata without creating a git tag:

```bash
ACP_RELEASE_TAG=agent-worker-$(git rev-parse --short HEAD) pnpm release:tag
```

Override the image tag when publishing from CI or a release shell:

```bash
AGENT_WORKER_IMAGE=ghcr.io/michaelx1993/agent-worker:$(git rev-parse --short HEAD) pnpm release:image
```

Release tags publish immutable multi-arch GHCR images from GitHub hosted Actions:

```bash
git tag agent-worker-v0.0.1
git push origin agent-worker-v0.0.1
docker pull ghcr.io/michaelx1993/agent-worker:0.0.1
```

Validate a deploy target without changing the running service:

```bash
AGENT_WORKER_DEPLOY_IMAGE=ghcr.io/michaelx1993/agent-worker:$(git rev-parse --short HEAD) pnpm deploy:compose
```

Apply the deploy after the dry-run succeeds:

```bash
AGENT_WORKER_DEPLOY_IMAGE=ghcr.io/michaelx1993/agent-worker:$(git rev-parse --short HEAD) AGENT_WORKER_DEPLOY_APPLY=true pnpm deploy:compose
```

Validate a rollback target without changing the running service:

```bash
AGENT_WORKER_ROLLBACK_IMAGE=ghcr.io/michaelx1993/agent-worker:previous pnpm rollback:compose
```

Apply the rollback after the dry-run succeeds:

```bash
AGENT_WORKER_ROLLBACK_IMAGE=ghcr.io/michaelx1993/agent-worker:previous AGENT_WORKER_ROLLBACK_APPLY=true pnpm rollback:compose
```
