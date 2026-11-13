import { spawn } from "node:child_process";
import { resetDatabase } from "@/db/reset-database";
import { SINGLE_DATABASE_ADMIN_URL, SINGLE_DATABASE_URL, SINGLE_ENV } from "./env";

// Every run starts from Fernwood alone (localhost only, the same guard as db:reset), with a worker beside the
// server for the jobs the app adds (Customize's Apply); it stops when the run ends.
export default async function globalSetup() {
  await fetch("http://localhost:8025/api/v1/messages", { method: "DELETE" }).catch(() => {});
  // The seed replays recorded AI answers (its AI steps), with the same settings as the server and the worker.
  Object.assign(process.env, { AI_PROVIDER: SINGLE_ENV.AI_PROVIDER, AI_MODEL_LARGE: SINGLE_ENV.AI_MODEL_LARGE, AI_MODEL_SMALL: SINGLE_ENV.AI_MODEL_SMALL, ANTHROPIC_API_KEY: "" });
  await resetDatabase({ adminUrl: SINGLE_DATABASE_ADMIN_URL, appUrl: SINGLE_DATABASE_URL, only: "fernwood" });
  const worker = spawn("pnpm", ["exec", "tsx", "server/jobs/worker.ts"], { env: { ...process.env, ...SINGLE_ENV }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The worker didn't start in 60 s.")), 60_000);
    worker.stdout.on("data", (b: Buffer) => {
      if (process.env.CI) process.stdout.write(`[worker] ${b.toString()}`);
      if (b.toString().includes("Worker started")) {
        clearTimeout(timer);
        resolve();
      }
    });
    worker.on("exit", (code) => reject(new Error(`The worker stopped (${code}).`)));
  });
  return () => {
    worker.kill();
  };
}
