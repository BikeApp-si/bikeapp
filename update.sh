#!/bin/sh
# Moves Bike to another version, newer or older: sh update.sh 0.6.1 (and back: sh update.sh 0.6.0). Run it in the
# folder with compose.yaml and .env. It
#   1. checks the new image's signature: it must be the one Bike's release published from its public code;
#   2. makes a backup of Bike as it is now, into ./backups;
#   3. pulls exactly the image whose signature it checked (by its digest), sets BIKE_VERSION in .env and restarts
#      Bike with it.
# Bike's database updates only add, so going back to the version before keeps everything entered since.
set -eu
cd "$(dirname "$0")"

NEW=${1:-}
case "$NEW" in
  "" | *[!0-9A-Za-z.-]*) echo "Usage: sh update.sh <version>, for example: sh update.sh 0.6.1" >&2; exit 2 ;;
esac
[ -f .env ] || { echo "There is no .env here. Run update.sh in the folder with compose.yaml and .env." >&2; exit 2; }
OLD=$(sed -n 's/^BIKE_VERSION=//p' .env)
IMAGE=${BIKE_IMAGE:-ghcr.io/bikeapp-si/bikeapp}
COSIGN=ghcr.io/sigstore/cosign/cosign:v2.4.1

# 1. The signature, checked by cosign in its own container (nothing to install). COSIGN_PUBLIC_KEY and
# COSIGN_NETWORK are for testing this script with a key of our own (scripts/update-run.sh), never for a real update.
echo "Checking the signature of Bike ${NEW}…"
if [ -n "${COSIGN_PUBLIC_KEY:-}" ]; then
  set -- --key /cosign.pub --insecure-ignore-tlog=true --allow-insecure-registry
  KEYMOUNT="-v $COSIGN_PUBLIC_KEY:/cosign.pub:ro"
else
  set -- --certificate-identity-regexp '^https://github.com/BikeApp-si/bikeapp/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  KEYMOUNT=""
fi
# shellcheck disable=SC2086
VERIFIED=$(docker run --rm --network "${COSIGN_NETWORK:-bridge}" $KEYMOUNT "$COSIGN" verify "$@" "$IMAGE:$NEW" 2>/dev/null || true)
# The digest of the image the signature is for: that image, not whatever the tag names later, is the one run.
DIGEST=$(printf '%s' "$VERIFIED" | grep -o '"docker-manifest-digest":"sha256:[0-9a-f]\{64\}"' | head -1 | cut -d'"' -f4)
if [ -z "$DIGEST" ]; then
  echo "Bike $NEW wasn't updated to: its image isn't signed by Bike's release, or it doesn't exist. Nothing was changed." >&2
  echo "Check the version at https://github.com/BikeApp-si/bikeapp/releases." >&2
  exit 1
fi

# 2. A backup of Bike as it is (the database must be up; Bike itself may be stopped).
echo "Backing up Bike ${OLD}…"
docker compose up -d --wait postgres
docker compose run --rm web bike backup

# 3. The new version.
docker pull -q "$IMAGE@$DIGEST" >/dev/null
docker tag "$IMAGE@$DIGEST" "$IMAGE:$NEW"
TMP=$(mktemp .env.XXXXXX)
sed "s/^BIKE_VERSION=.*/BIKE_VERSION=$NEW/" .env > "$TMP" && cat "$TMP" > .env && rm -f "$TMP"
echo "Starting Bike ${NEW}…"
if ! docker compose up -d --wait --pull never; then
  echo "Bike $NEW didn't start. See docker compose logs web. To go back: sh update.sh $OLD" >&2
  exit 1
fi
echo "Bike is now $NEW. To go back: sh update.sh $OLD"
