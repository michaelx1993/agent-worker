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
