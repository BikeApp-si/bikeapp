# Update Bike

Each release has a version (`0.6.3`); `.env`'s `BIKE_VERSION` says which one runs. To update:

```sh
sh update.sh 0.6.3
```

It checks the new image's signature (with cosign, in its own container: nothing to install), makes a backup, sets
`BIKE_VERSION`, pulls the image and restarts Bike. An image that isn't signed by Bike's release is refused and
nothing changes. Settings › Instance says when a newer version is out (Bike asks GitHub once a day; nothing about
your company is sent; `UPDATE_CHECK=off` in `.env` stops it).

To go back, run it with the version before: `sh update.sh 0.6.2`. Bike's database updates only add, so the version
before runs on the updated database and keeps everything entered since.

When Bike starts on a version with database updates to apply, it makes a backup first, whether or not `update.sh`
started it. If that backup fails (a full disk, say), Bike doesn't update the database and says why in its log.
