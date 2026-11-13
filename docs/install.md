# Install Bike on your own server

Bike runs as four containers on one machine: Bike itself (`web`), its worker, PostgreSQL 16 and ClamAV, which checks
every upload for viruses. Your data stays in Docker volumes on that machine, and its backups in a `backups` folder
beside them.

## What you need

- A 64-bit Linux machine, x86-64 or ARM, with 2 CPUs and 4–8 GB of memory (ClamAV alone uses about 1.5 GB), and Docker with Compose v2.
- An address for Bike, such as `https://bike.example.com`, with HTTPS from your own proxy or load balancer, or from
  Caddy beside Bike (see [HTTPS](#https)). A plain `http://` address on your own network works too, but people's
  sign-ins then cross it unencrypted.
- Optional: a mail relay (SMTP) for sign-in codes and Bike's emails, and your company's Anthropic key for building
  apps from chat ([AI](ai.md)). Bike works without either.

## Install

1. In a folder of its own on the server, fetch the release's three files and copy `.env.example` to `.env`:

   ```sh
   mkdir bike && cd bike
   for f in compose.yaml .env.example update.sh; do
     curl -fsSLO "https://raw.githubusercontent.com/BikeApp-si/bikeapp/v0.6.1/$f"
   done
   cp .env.example .env
   ```

2. Fill in `.env`: your address (`INSTANCE_URL`), two database passwords and a session secret (each line says how
   to make one), and if you have them, `SMTP_URL` and `EMAIL_FROM`. Your Anthropic key can go in Bike itself ([AI](ai.md)).
3. Check the image is the one Bike's release built from this repo's code (cosign runs in its own container):

   ```sh
   docker run --rm ghcr.io/sigstore/cosign/cosign:v2.4.1 verify ghcr.io/bikeapp-si/bikeapp:0.6.1 \
     --certificate-identity-regexp '^https://github.com/BikeApp-si/bikeapp/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

4. Start Bike: `docker compose up -d`. The first start readies the database; ClamAV takes a few more minutes to
   download its virus list.
5. Find the setup code in Bike's log: `docker compose logs web | grep "Setup code"`.
6. Open your address. Type the setup code, your company's name, your name, email and time zone, and if you have
   it your company's Anthropic key, and click **Create company**. You are its first admin.
7. Sign in with the code Bike sends you. With no mail relay, it is in Bike's log:
   `docker compose logs web | grep "Sign-in code"`.

Then check **Settings › Instance**: each part Bike needs, and how to fix any that isn't working.

## Without a mail relay

Bike works, but sends no email. Admins find their sign-in codes in Bike's log; nobody else can sign in until
`SMTP_URL` is set. Set it in `.env` and run `docker compose up -d` to restart Bike with it.

## If the setup code is used up or lost

Five wrong tries write a new code to the log. Restarting Bike (`docker compose restart web`) writes a new one too,
until your company is created.

## HTTPS

If you have no proxy of your own, Caddy can serve Bike over HTTPS. It gets a free certificate for Bike's address
from Let's Encrypt and renews it by itself. You need:

- a public name for Bike (`bike.example.com`) pointing at this server, and `INSTANCE_URL=https://bike.example.com`;
- ports 80 and 443 open to the internet (Let's Encrypt checks the name through them).

In `.env`, add `COMPOSE_PROFILES=https`, and set `BIKE_PORT=127.0.0.1:3000` so Bike answers only through Caddy.
Then `docker compose up -d`. Caddy's certificate is in its own volume, kept across restarts.

## Then

- [Update](update.md): new versions, and going back.
- [Back up and restore](backup.md).
- [AI](ai.md): your company's Anthropic key, a monthly cap, or no model at all.
