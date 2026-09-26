# syntax=docker/dockerfile:1
# One image for the demo host's Node services: the gateway (`streamotter start`)
# and the field station, run with different commands (see compose.yaml). It holds
# only the field station's workspace, the simulation, and their production
# dependencies from npm, including the pinned streamotter package.
#
#   docker build -f deploy/Dockerfile .      (from the repository root)
#
# Built for linux/amd64 and linux/arm64 (the Oracle Ampere host).

FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/creek-sim/package.json packages/creek-sim/
COPY apps/field-station/package.json apps/field-station/
COPY apps/site/package.json apps/site/
RUN npm ci --workspace @lontra-creek/field-station --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/creek-sim/src packages/creek-sim/src
COPY apps/field-station apps/field-station
# streamotter start loads JavaScript only: compile the gateway's handlers.
RUN npm run build -w @lontra-creek/field-station

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/creek-sim/package.json packages/creek-sim/
COPY apps/field-station/package.json apps/field-station/
# The site's manifest keeps the lockfile's workspaces whole; none of its packages are installed.
COPY apps/site/package.json apps/site/
RUN npm ci --omit=dev --workspace @lontra-creek/field-station --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY packages/creek-sim/src packages/creek-sim/src
COPY apps/field-station/src apps/field-station/src
COPY apps/field-station/streamotter.production.json apps/field-station/
COPY --from=build /app/apps/field-station/dist apps/field-station/dist
# The field station's checkpoints live here, on a volume owned by the unprivileged node user.
RUN mkdir -p /var/lib/lontra && chown node:node /var/lib/lontra
USER node
WORKDIR /app/apps/field-station
CMD ["node", "--disable-warning=TimeoutNegativeWarning", "src/server/main.ts"]
