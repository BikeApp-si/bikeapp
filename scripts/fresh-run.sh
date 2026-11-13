#!/bin/sh
# O2's Done when, on this machine: the open Bike's image built from the exported tree, installed from compose.yaml
# on empty volumes, twice: with a mail relay (dev's Mailpit, `pnpm db:up`) and with none. First run, sign in and
# Settings › Instance are checked in a browser (tests/fresh-run). Usage: sh scripts/fresh-run.sh
set -eu
ROOT=$(pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bike-fresh.XXXXXX")
IMAGE=ghcr.io/bikeapp-si/bikeapp:fresh
export COMPOSE_PROJECT_NAME=bike-fresh

pnpm export:open "$WORK/open"
docker build --build-arg BIKE_VERSION=fresh -t "$IMAGE" "$WORK/open"
mkdir -p "$WORK/install"
cp "$WORK/open/compose.yaml" "$WORK/install/compose.yaml"

COMPOSE="docker compose --project-directory $WORK/install"
for relay in mailpit none; do
  {
    echo "INSTANCE_URL=http://localhost:3300"
    echo "BIKE_PORT=3300"
    echo "DB_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    if [ "$relay" = mailpit ]; then echo "SMTP_URL=smtp://host.docker.internal:1025"; else echo "SMTP_URL="; fi
    echo "EMAIL_FROM=Bike <bike@juniper.dev>"
    echo "ANTHROPIC_API_KEY="
    echo "BIKE_VERSION=fresh"
  } > "$WORK/install/.env"
  # Empty volumes for the data and files; the virus list is kept between runs (a few minutes to download).
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f bike-fresh_db bike-fresh_files >/dev/null
  $COMPOSE up -d --wait
  FRESH_URL=http://localhost:3300 FRESH_RELAY=$relay FRESH_COMPOSE="$COMPOSE" pnpm exec playwright test --config "$ROOT/playwright.fresh.config.ts"
done
$COMPOSE down
echo "Fresh run passed, with and without a mail relay. Left in $WORK"
