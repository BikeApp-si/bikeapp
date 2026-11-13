import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteFile, diskPath, getFile, putFile, storageEnv, storagePlace } from "./storage";

// Storage settings under our names, or the ones `fly storage create` sets for Tigris.
describe("storage settings", () => {
  it("reads S3_* first, then Tigris's AWS_* and BUCKET_NAME, then dev's defaults", () => {
    expect(storageEnv({ AWS_ACCESS_KEY_ID: "tid", AWS_SECRET_ACCESS_KEY: "tsecret", AWS_REGION: "auto", AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev/", BUCKET_NAME: "bike-files" })).toEqual({
      accessKeyId: "tid",
      secretAccessKey: "tsecret",
      region: "auto",
      endpoint: "https://fly.storage.tigris.dev",
      bucket: "bike-files",
    });
    expect(storageEnv({ S3_BUCKET: "mine", BUCKET_NAME: "theirs" }).bucket).toBe("mine");
    expect(storageEnv({})).toMatchObject({ endpoint: "http://localhost:8333", bucket: "bike-dev", region: "us-east-1" });
  });
});

describe("putting a file", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("sends its length, which Tigris requires (411 without it)", async () => {
    Object.assign(process.env, { STORAGE_PROVIDER: "s3", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "https://fly.storage.tigris.dev", S3_BUCKET: "bikeapp-si-files" });
    const sent: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => (sent.push(req), new Response(null, { status: 200 }))));
    await putFile("workspaces/w1/uploads/u1/contract.pdf", new TextEncoder().encode("%PDF-1.7 hello"), "application/pdf");
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe("https://fly.storage.tigris.dev/bikeapp-si-files/workspaces/w1/uploads/u1/contract.pdf");
    expect(sent[0]!.headers.get("content-length")).toBe("14");
  });
});

// The open Bike keeps files on its own disk (STORAGE_PROVIDER=disk, FILES_DIR).
describe("files on disk", () => {
  const env = { ...process.env };
  let dir = "";
  afterEach(async () => {
    process.env = { ...env };
    await rm(dir, { recursive: true, force: true });
  });
  const onDisk = async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bike-files-"));
    Object.assign(process.env, { STORAGE_PROVIDER: "disk", FILES_DIR: dir });
  };

  it("keeps a file and its type, reads it back, and removes both", async () => {
    await onDisk();
    const key = "workspaces/w1/uploads/u1/contract 2026.pdf";
    await putFile(key, new TextEncoder().encode("%PDF-1.7 hello"), "application/pdf");
    expect(await getFile(key)).toEqual({ body: new TextEncoder().encode("%PDF-1.7 hello"), mime: "application/pdf" });
    expect(await readdir(path.join(dir, "workspaces/w1/uploads/u1"))).toEqual(["contract 2026.pdf", "contract 2026.pdf.type"]);
    await deleteFile(key);
    expect(await getFile(key)).toBeNull();
    expect(await readdir(path.join(dir, "workspaces/w1/uploads/u1"))).toEqual([]);
    await deleteFile(key); // already gone
  });

  it("finds no file where none was put", async () => {
    await onDisk();
    expect(await getFile("workspaces/w1/uploads/none/a.txt")).toBeNull();
  });

  it("never reaches outside FILES_DIR", () => {
    expect(() => diskPath("../etc/passwd", "/data/files")).toThrow("Not a file key");
    expect(() => diskPath("workspaces/../../etc/passwd", "/data/files")).toThrow("Not a file key");
    expect(() => diskPath("/etc/passwd", "/data/files")).toThrow("Not a file key");
    expect(() => diskPath("", "/data/files")).toThrow("Not a file key");
    expect(diskPath("workspaces/w1/uploads/u1/a.pdf", "/data/files")).toBe("/data/files/workspaces/w1/uploads/u1/a.pdf");
  });

  it("says where files are kept", async () => {
    await onDisk();
    expect(storagePlace()).toBe(`on this server's disk (${dir})`);
  });
});
