FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json

RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY .prettierrc .prettierrc

RUN pnpm --filter @agent-control-plane/core build && pnpm --filter @agent-control-plane/worker build

CMD ["node", "apps/worker/dist/index.js"]
