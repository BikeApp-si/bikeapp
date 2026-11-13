# Back up and restore

Bike makes a backup each night after 02:00, in your company's time zone, into the `backups` folder beside
`compose.yaml`. It keeps the last 7 nightly ones and the last 3 made before an update; the ones you make yourself
stay until you remove them. To make one now:

```sh
docker compose exec web bike backup
```

Each backup is one file (`bike-0.6.0-2026-11-13-0100-nightly.tar`, the time in UTC) holding the database, every
uploaded file and Bike's version. Copy the `backups` folder somewhere off this server (another machine, a storage
service), so a lost server doesn't take its backups with it. Settings › Instance shows the last backup, and says so
when there has been none for two days.

A backup doesn't hold `.env`. Keep a copy of it somewhere safe on its own: it has the passwords and the session
secret. Restored under a different `SESSION_SECRET`, everyone signs in again and the Anthropic key set in
Settings › AI has to be added again.

## Restore on another machine

A backup restores into a new Bike that hasn't been through first run, of the same version or newer.

1. [Install Bike](install.md) (steps 1–4), with the same `BIKE_VERSION` as the backup or newer, but don't open its
   address: no first run.
2. Copy the backup into its `backups` folder, and stop Bike: `docker compose stop web worker`.
3. Restore: `docker compose run --rm web bike restore backups/bike-0.6.0-2026-11-13-0100-nightly.tar`
4. Start Bike: `docker compose up -d`. Sign in as before.

A Bike that already has a company refuses a restore, and so does one older than the Bike that made the backup:
update it first.
