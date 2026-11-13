// Workspace address rules (brief › Workspace addresses).
export const RESERVED = ["app", "api", "admin", "www", "mail", "help", "status", "docs"] as const;

export type AddressCheck = { ok: true } | { ok: false; reason: string };

export function checkAddress(sub: string): AddressCheck {
  if (sub.length < 3) return { ok: false, reason: "Use at least 3 characters." };
  if (sub.length > 30) return { ok: false, reason: "Use at most 30 characters." };
  if (!/^[a-z0-9-]+$/.test(sub)) return { ok: false, reason: "Use lowercase letters, numbers and hyphens only." };
  if (sub.startsWith("-") || sub.endsWith("-")) return { ok: false, reason: "It can't start or end with a hyphen." };
  if ((RESERVED as readonly string[]).includes(sub)) return { ok: false, reason: "That address is reserved." };
  return { ok: true };
}

const COMPANY_SUFFIXES = /\b(labs?|inc|llc|ltd|limited|co|company|corp|corporation|gmbh|plc|pvt|private|group|d\.?o\.?o)\.?$/i;

// "Fernwood Labs" → "Fernwood"
export function shortName(name: string): string {
  const trimmed = name.trim();
  const short = trimmed.replace(COMPANY_SUFFIXES, "").replace(/[\s,.-]+$/, "").trim();
  return short || trimmed;
}

// "Fernwood Labs" → "fernwood"
export function suggestAddress(company: string): string {
  return shortName(company)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}
