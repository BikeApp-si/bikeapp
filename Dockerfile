# Bike's image, for both Fly processes: the app (`pnpm start`) and the worker (`pnpm worker`), and the release
# step (`pnpm db:migrate`). The open Bike runs the same image through docker/start.sh (web, worker). The worker and migrations run TypeScript with tsx, so dependencies stay whole.
# Chromium (headless) is here for report PDFs (server/report/pdf.tsx).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/corepack
# pnpm itself, in the image (package.json's version), so a starting machine never downloads it.
COPY package.json ./
RUN corepack enable && corepack install && chmod -R a+rX /corepack
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Server actions are allowed from the workspaces' addresses, fixed when the app is built (next.config.ts).
ARG ROOT_HOST=bikeapp.si
ENV ROOT_HOST=$ROOT_HOST
RUN pnpm exec next build

FROM base AS run
ENV NODE_ENV=production PORT=3000
# What Settings › Instance shows as the version (the release's tag; "dev" for a local build).
ARG BIKE_VERSION=dev
ENV BIKE_VERSION=$BIKE_VERSION
# Chromium's headless shell and the libraries and fonts it needs, for PDFs.
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm exec playwright-core install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*
# pg_dump and pg_restore 16, for the open Bike's backups (Debian 12 ships 15, which can't read a 16 server).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-16 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=build /app ./
# The open Bike keeps files and backups here (STORAGE_PROVIDER=disk); a volume mounted on one starts owned by the
# app's user. `bike backup` and `bike restore` (docker/bike) run from anywhere in the container.
RUN mkdir -p /data/files /data/backups && chown node:node /data/files /data/backups \
  && printf '#!/bin/sh\nexec sh /app/docker/bike "$@"\n' > /usr/local/bin/bike && chmod 755 /usr/local/bin/bike
USER node
EXPOSE 3000
CMD ["pnpm", "start"]
