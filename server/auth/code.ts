import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// 6 characters, easy to read: no O, I, L, 0 or 1.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
export const RESEND_AFTER_MS = 60_000;

export function newCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// What people type or paste: any case, with or without the dash or spaces.
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// K7Q4W8 → K7Q-4W8
export function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Set SESSION_SECRET in .env");
  return s;
}

export function hashCode(email: string, code: string): string {
  return createHmac("sha256", secret()).update(`${email.toLowerCase()}:${normalizeCode(code)}`).digest("hex");
}

export function codeMatches(hash: string, email: string, input: string): boolean {
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashCode(email, input), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
