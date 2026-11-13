import { createHash, randomBytes } from "node:crypto";

// Random tokens for cookies and links. Only the sha256 is stored.
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
