// An Audit entry's details as one line, the way 9a shows them: "Contracts/Northwind · Value a year 38400 → 41000".
// Mechanical, with no rewording: each recorded key and value, joined with " · ". The database keeps keys in
// its own order, so the row, the version and from → to come first, then the rest.

const words = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const plain = (v: unknown): string => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const version = (v: unknown) => (typeof v === "number" ? `v${v}` : plain(v));

export function detailsText(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const d = { ...details };
  if (typeof d.sheet === "string" && typeof d.row === "string") {
    parts.push(`${d.sheet}/${d.row}`);
    delete d.sheet;
    delete d.row;
  }
  if (typeof d.version === "number") {
    parts.push(`v${d.version}`);
    delete d.version;
  }
  if ("from" in d && "to" in d) {
    parts.push(`${version(d.from)} → ${version(d.to)}`);
    delete d.from;
    delete d.to;
  }
  for (const [key, v] of Object.entries(d)) {
    if (key === "changes" && Array.isArray(v)) {
      for (const c of v as { name?: string; from?: unknown; to?: unknown }[]) parts.push(`${c.name} ${plain(c.from)} → ${plain(c.to)}`);
    } else if (typeof v === "number") parts.push(`${v} ${words(key)}`);
    else if (typeof v === "string") parts.push(v);
    else if (typeof v === "boolean") parts.push(v ? words(key) : `not ${words(key)}`);
    else if (Array.isArray(v)) parts.push(`${v.length} ${words(key)} (${v.map(plain).join(", ")})`);
    else if (v && typeof v === "object" && "from" in v && "to" in v) {
      const o = v as { from: unknown; to: unknown };
      parts.push(`${words(key)} ${plain(o.from)} → ${plain(o.to)}`);
    } else parts.push(`${words(key)} ${plain(v)}`);
  }
  return parts.join(" · ");
}
