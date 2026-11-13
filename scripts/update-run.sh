#!/bin/sh
# O4's Done when, on this machine. From the exported tree, three images in a local registry: 0.6.0, 0.6.1 (0.6.0 plus
# a database update that adds a column), both signed with a throwaway cosign key, and 0.6.2, unsigned. Then:
#   1. install 0.6.0, first run, a logo uploaded (tests/update-run);
#   2. start 0.6.1 by hand (no update.sh): a backup before its database update, then the update;
#   3. update.sh 0.6.0: back to the version before, on the updated database, everything there;
#   4. update.sh 0.6.1 again, and a backup by hand (bike backup);
#   5. update.sh 0.6.2: refused (no signature), nothing changed;
#   6. a second install (another SESSION_SECRET) restores the backup; a second restore into it is refused;
#   7. Caddy's https profile answers on https://localhost with its own local certificate.
# Needs ports 3300, 3301, 5055, 80 and 443 free. Usage: sh scripts/update-run.sh
set -eu
ROOT=$(pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bike-update.XXXXXX")
REGNAME=bike-update-registry
IMAGE=localhost:5055/bike
COSIGN=ghcr.io/sigstore/cosign/cosign:v2.4.1
ADMIN=rita.$(date +%s)@juniper.dev
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

step "A local registry and three images"
docker rm -f -v "$REGNAME" >/dev/null 2>&1 || true
docker run -d --name "$REGNAME" -e REGISTRY_HTTP_ADDR=:5055 -p 5055:5055 registry:2.8.3 >/dev/null
pnpm export:open "$WORK/open"
cp -R "$WORK/open" "$WORK/open-next"
cat > "$WORK/open-next/db/migrations/0050_update_run.sql" <<'SQL'
-- scripts/update-run.sh only: the next version's database update, which adds a column.
ALTER TABLE "instance_settings" ADD COLUMN "update_run" text;
SQL
node -e '
  const fs = require("fs"); const p = process.argv[1]; const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const last = j.entries.at(-1);
  j.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 86400000, tag: "0050_update_run", breakpoints: true });
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$WORK/open-next/db/migrations/meta/_journal.json"
docker build -q --build-arg BIKE_VERSION=0.6.0 -t "$IMAGE:0.6.0" "$WORK/open" >/dev/null
docker build -q --build-arg BIKE_VERSION=0.6.1 -t "$IMAGE:0.6.1" "$WORK/open-next" >/dev/null
# 0.6.2 must be another image: a signature belongs to an image's digest, so a new tag on 0.6.0 would be signed.
printf 'FROM %s:0.6.0\nLABEL si.bikeapp.update-run=unsigned\n' "$IMAGE" | docker build -q -t "$IMAGE:0.6.2" - >/dev/null
for v in 0.6.0 0.6.1 0.6.2; do docker push -q "$IMAGE:$v" >/dev/null; done

mkdir -p "$WORK/keys"
docker run --rm -u "$(id -u)" -v "$WORK/keys:/keys" -w /keys -e COSIGN_PASSWORD= "$COSIGN" generate-key-pair >/dev/null
for v in 0.6.0 0.6.1; do
  docker run --rm --network "container:$REGNAME" -v "$WORK/keys:/keys:ro" -e COSIGN_PASSWORD= "$COSIGN" \
    sign --key /keys/cosign.key --tlog-upload=false --allow-insecure-registry --yes "$IMAGE:$v" >/dev/null 2>&1
done
export BIKE_IMAGE="$IMAGE" COSIGN_PUBLIC_KEY="$WORK/keys/cosign.pub" COSIGN_NETWORK="container:$REGNAME"

# An install: compose.yaml from the export, pulling from the local registry, and its .env.
install() { # dir port version
  mkdir -p "$1/backups"
  sed "s#ghcr.io/bikeapp-si/bikeapp#$IMAGE#" "$WORK/open/compose.yaml" > "$1/compose.yaml"
  cp "$WORK/open/update.sh" "$1/update.sh"
  {
    echo "INSTANCE_URL=http://localhost:$2"
    echo "BIKE_PORT=$2"
    echo "DB_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "SMTP_URL="
    echo "EMAIL_FROM=Bike <bike@juniper.dev>"
    echo "ANTHROPIC_API_KEY="
    echo "BIKE_VERSION=$3"
    echo "UPDATE_CHECK=off"
  } > "$1/.env"
}
check() { # dir port version
  UPDATE_STEP=check UPDATE_URL="http://localhost:$2" UPDATE_VERSION="$3" UPDATE_ADMIN="$ADMIN" \
    UPDATE_COMPOSE="docker compose --project-directory $1" \
    pnpm exec playwright test --config "$ROOT/playwright.update.config.ts" --reporter=line
}
psql_in() { docker compose --project-directory "$1" exec -T postgres psql -U bike -d bike -tAc "$2"; }
running() { docker compose --project-directory "$1" exec -T web printenv BIKE_VERSION; }

A="$WORK/install"
export COMPOSE_PROJECT_NAME=bike-update
step "1. Install 0.6.0"
install "$A" 3300 0.6.0
docker compose --project-directory "$A" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose --project-directory "$A" up -d --wait
UPDATE_STEP=install UPDATE_URL=http://localhost:3300 UPDATE_ADMIN="$ADMIN" UPDATE_COMPOSE="docker compose --project-directory $A" \
  pnpm exec playwright test --config "$ROOT/playwright.update.config.ts" --reporter=line
check "$A" 3300 0.6.0

step "2. 0.6.1 started by hand: a backup before its database update"
sed -i.bak "s/^BIKE_VERSION=.*/BIKE_VERSION=0.6.1/" "$A/.env"
docker compose --project-directory "$A" up -d --wait
ls "$A/backups" | grep -q -- "-before-update.tar$" || fail "no backup before the database update"
[ "$(psql_in "$A" "select count(*) from information_schema.columns where table_name = 'instance_settings' and column_name = 'update_run'")" = 1 ] || fail "0.6.1's database update didn't run"
check "$A" 3300 0.6.1

step "3. Back to 0.6.0 (update.sh), on the updated database"
sh "$A/update.sh" 0.6.0
[ "$(running "$A")" = 0.6.0 ] || fail "0.6.0 isn't running"
# 0.6.0 knows nothing of 0.6.1's column; something written in it now must still be there after going forward.
psql_in "$A" "insert into instance_settings (id, updated_at, update_run) values (1, now(), 'kept') on conflict (id) do update set update_run = 'kept'" >/dev/null
check "$A" 3300 0.6.0

step "4. Forward to 0.6.1 again, and a backup by hand"
sh "$A/update.sh" 0.6.1
[ "$(psql_in "$A" "select update_run from instance_settings")" = kept ] || fail "0.6.1's column lost what was written in it"
docker compose --project-directory "$A" exec -T web bike backup
BACKUP=$(ls -t "$A/backups" | grep -- "-manual.tar$" | head -1)
tar -tf "$A/backups/$BACKUP" | grep -q "^files/" || fail "the backup has no files"
check "$A" 3300 0.6.1

step "5. 0.6.2, unsigned: refused"
if sh "$A/update.sh" 0.6.2; then fail "an unsigned image was taken"; fi
grep -q "^BIKE_VERSION=0.6.1$" "$A/.env" || fail ".env changed"
[ "$(running "$A")" = 0.6.1 ] || fail "0.6.1 isn't running"

step "6. Restore into a second install"
B="$WORK/restore"
install "$B" 3301 0.6.1
cp "$A/backups/$BACKUP" "$B/backups/"
export COMPOSE_PROJECT_NAME=bike-restore
docker compose --project-directory "$B" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose --project-directory "$B" up -d --wait
docker compose --project-directory "$B" stop web worker
docker compose --project-directory "$B" run --rm web bike restore "backups/$BACKUP"
docker compose --project-directory "$B" up -d --wait
check "$B" 3301 0.6.1
docker compose --project-directory "$B" stop web worker
if docker compose --project-directory "$B" run --rm web bike restore "backups/$BACKUP" 2> "$WORK/refused.txt"; then fail "a restore over a company was taken"; fi
grep -q "This Bike already has a company in it (Juniper Outfitters)" "$WORK/refused.txt" || fail "the refusal didn't say why"
docker compose --project-directory "$B" down

step "7. Caddy on https://localhost"
export COMPOSE_PROJECT_NAME=bike-update
INSTANCE_URL=https://localhost docker compose --project-directory "$A" --profile https up -d --wait caddy
# A new Caddy makes its local certificate on the first request: up to 30 seconds.
ok=0; for _ in $(seq 1 30); do curl -skf https://localhost/healthz >/dev/null && { ok=1; break; }; sleep 1; done
[ "$ok" = 1 ] || fail "Caddy didn't answer on https://localhost"
docker compose --project-directory "$A" --profile https down

docker rm -f -v "$REGNAME" >/dev/null
echo "Update run passed: update, a backup before it, back and forward, an unsigned image refused, a restore on a second install, and Caddy. Left in $WORK"
