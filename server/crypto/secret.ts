import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// A secret kept in the database (the company's Anthropic key, O3), sealed with AES-256-GCM under a key derived from
// SESSION_SECRET for one purpose. Without the same SESSION_SECRET it can't be read; changed bytes are refused.

export class SealBroken extends Error {}

function keyFor(purpose: string, secret: string | undefined): Buffer {
  if (!secret) throw new Error("Set SESSION_SECRET in .env");
  return Buffer.from(hkdfSync("sha256", secret, "bike-sealed", purpose, 32));
}

// "v1.<iv>.<tag>.<text>", each base64url.
export function seal(text: string, purpose: string, secret = process.env.SESSION_SECRET): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose, secret), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), body].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function unseal(sealed: string, purpose: string, secret = process.env.SESSION_SECRET): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new SealBroken("Not a sealed value.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose, secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SealBroken("It can't be read with this SESSION_SECRET.");
  }
}
