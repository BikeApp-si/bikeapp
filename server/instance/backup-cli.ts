// `bike backup`, `bike restore <file>` and, from docker/start.sh, `before-update` (docker/bike runs this).
// Usage: tsx server/instance/backup-cli.ts backup | restore <file> | before-update
import path from "node:path";
import { direct } from "@/db/urls";
import { filesDir } from "@/server/files/storage";
import { migrationsShipped } from "./health";
import { backupBeforeUpdate, BackupRefused, backupsDir, makeBackup, restoreBackup, type Backup } from "./backup";

try { process.loadEnvFile(); } catch {}

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("Set DATABASE_ADMIN_URL");
const db = { adminUrl: direct(adminUrl), filesDir: filesDir(), version: process.env.BIKE_VERSION || "dev" };
const mb = (b: Backup) => `${(b.bytes / 1_000_000).toFixed(1)} MB`;

const [command, arg] = process.argv.slice(2);
try {
  if (command === "backup") {
    const b = await makeBackup({ ...db, why: "manual" });
    console.log(`Backup made: backups/${b.name} (${mb(b)}).`);
  } else if (command === "before-update") {
    const b = await backupBeforeUpdate({ ...db, shipped: migrationsShipped() }).catch((e: Error) => {
      console.error(`Bike didn’t update its database, because the backup before it failed: ${e.message}`);
      console.error("Free some space on the server (or check the backups folder can be written), then start Bike again.");
      process.exit(1);
    });
    if (b) console.log(`Backed up before updating the database: backups/${b.name} (${mb(b)}).`);
  } else if (command === "restore" && arg) {
    // A name in the backups folder, or a path to it as seen from the server (backups/…).
    const file = path.join(backupsDir(), path.basename(arg));
    const m = await restoreBackup({ ...db, file, shipped: migrationsShipped() });
    console.log(`Restored ${m.company ?? "the backup"} from ${m.madeAt.slice(0, 16).replace("T", " ")} UTC. Start Bike: docker compose up -d`);
  } else {
    console.error("Usage: bike backup | bike restore backups/<file>");
    process.exit(2);
  }
} catch (e) {
  if (!(e instanceof BackupRefused)) throw e;
  console.error(e.message);
  process.exit(1);
}
