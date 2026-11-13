import { AwsClient } from "aws4fetch";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// File bytes, under workspaces/<id>/… in one S3-compatible bucket (SeaweedFS in dev, Tigris on Fly), or on this
// server's disk under FILES_DIR (STORAGE_PROVIDER=disk, the open Bike's default in its compose file).
// STORAGE_PROVIDER=memory keeps them in memory for tests. Each setting is read under our name (S3_*) or the
// one `fly storage create` sets (AWS_*, BUCKET_NAME).

const memory = globalThis as unknown as { bikeFiles?: Map<string, { body: Uint8Array; mime: string }> };
const files = () => (memory.bikeFiles ??= new Map());

export const storageEnv = (env: Record<string, string | undefined> = process.env) => ({
  accessKeyId: env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
  region: env.S3_REGION ?? env.AWS_REGION ?? "us-east-1",
  endpoint: (env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? "http://localhost:8333").replace(/\/$/, ""),
  bucket: env.S3_BUCKET ?? env.BUCKET_NAME ?? "bike-dev",
});

let client: AwsClient | undefined;
function s3() {
  const { accessKeyId, secretAccessKey, region } = storageEnv();
  if (!accessKeyId || !secretAccessKey) throw new Error("Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or Tigris's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)");
  client ??= new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
  return client;
}
const url = (key: string) => {
  const { endpoint, bucket } = storageEnv();
  return `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
};
const inMemory = () => process.env.STORAGE_PROVIDER === "memory";
const onDisk = () => process.env.STORAGE_PROVIDER === "disk";

export const filesDir = (env: Record<string, string | undefined> = process.env) => path.resolve(env.FILES_DIR ?? "/data/files");

// A key's place on disk, never outside FILES_DIR. Its type sits beside it, as S3 keeps it with the object.
export function diskPath(key: string, dir = filesDir()): string {
  const full = path.resolve(dir, key);
  if (!key || path.isAbsolute(key) || !full.startsWith(dir + path.sep)) throw new Error(`Not a file key: ${key}`);
  return full;
}
const mimePath = (full: string) => `${full}.type`;

export const keyFor = (workspaceId: string, uploadId: string, name: string) => `workspaces/${workspaceId}/uploads/${uploadId}/${name}`;

export async function putFile(key: string, body: Uint8Array, mime: string): Promise<void> {
  if (inMemory()) return void files().set(key, { body, mime });
  if (onDisk()) {
    const full = diskPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    return writeFile(mimePath(full), mime);
  }
  // The length always sent: Tigris refuses a PUT without it (411), and fetch inside Next.js may stream the body.
  const res = await s3().fetch(url(key), { method: "PUT", body: body as BodyInit, headers: { "content-type": mime, "content-length": String(body.byteLength) } });
  if (!res.ok) throw new Error(`Storage refused the file (${res.status})`);
}

export async function getFile(key: string): Promise<{ body: Uint8Array; mime: string } | null> {
  if (inMemory()) return files().get(key) ?? null;
  if (onDisk()) {
    const full = diskPath(key);
    const body = await readFile(full).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (!body) return null;
    const mime = await readFile(mimePath(full), "utf8").catch(() => "application/octet-stream");
    return { body: new Uint8Array(body), mime };
  }
  const res = await s3().fetch(url(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Storage couldn't read the file (${res.status})`);
  return { body: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "application/octet-stream" };
}

// Removes a file; one that isn't there is already gone. (The health check's test file.)
export async function deleteFile(key: string): Promise<void> {
  if (inMemory()) return void files().delete(key);
  if (onDisk()) {
    const full = diskPath(key);
    await rm(full, { force: true });
    return rm(mimePath(full), { force: true });
  }
  const res = await s3().fetch(url(key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Storage couldn't remove the file (${res.status})`);
}

// Where files are kept, in plain words (Settings › Instance).
export function storagePlace(): string {
  if (inMemory()) return "in memory";
  if (onDisk()) return `on this server's disk (${filesDir()})`;
  return `in ${storageEnv().bucket} at ${new URL(storageEnv().endpoint).host}`;
}
