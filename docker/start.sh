#!/bin/sh
# The open Bike's containers (compose.yaml): "web" readies the database (the app's user, a backup when updates are
# pending, then every update, which only add) and serves Bike; "worker" runs the daily rules, reminders, emails and
# the nightly backup. Anything else runs as given.
set -e
# compose.yaml starts web and worker as root only so the backups folder (./backups on the server, which Docker makes
# owned by root) can be given to Bike's user; everything then runs as that user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data/backups && chown node:node /data/backups
  HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups -- sh "$0" "$@"
fi
case "$1" in
  web)
    pnpm exec tsx db/app-role.ts
    pnpm exec tsx server/instance/backup-cli.ts before-update
    pnpm db:migrate
    exec pnpm start
    ;;
  worker)
    exec pnpm worker
    ;;
  *)
    exec "$@"
    ;;
esac
