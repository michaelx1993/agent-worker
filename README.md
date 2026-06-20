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
pnpm release:image
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

Override the image tag when publishing from CI or a release shell:

```bash
AGENT_WORKER_IMAGE=ghcr.io/michaelx1993/agent-worker:$(git rev-parse --short HEAD) pnpm release:image
```

Validate a rollback target without changing the running service:

```bash
AGENT_WORKER_ROLLBACK_IMAGE=ghcr.io/michaelx1993/agent-worker:previous pnpm rollback:compose
```

Apply the rollback after the dry-run succeeds:

```bash
AGENT_WORKER_ROLLBACK_IMAGE=ghcr.io/michaelx1993/agent-worker:previous AGENT_WORKER_ROLLBACK_APPLY=true pnpm rollback:compose
```
