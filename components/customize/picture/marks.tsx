import { cn } from "@/lib/utils";
import type { Changed, Mark } from "@/server/kernel/render-picture";

// What a waiting change adds (green) and alters (amber, the old words struck through), wherever it shows (V1).

export function MarkTag({ mark }: { mark: Mark }) {
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 text-[11.5px] font-semibold whitespace-nowrap", mark === "new" ? "bg-[#DDF6E2] text-[#18794E]" : "bg-[#FEF3C7] text-[#B45309]")}>
      {mark === "new" ? "New" : "Changed"}
    </span>
  );
}

export const Added = ({ children }: { children: React.ReactNode }) => <span className="rounded-[3px] bg-[#DDF6E2] px-[3px] text-[#18794E]">{children}</span>;

// "~~60~~ 90 days before …": the sentence as it will read, the words it replaces struck through beside them.
export function ChangedWords({ change }: { change: Changed }) {
  return (
    <>
      {change.before ? `${change.before} ` : ""}
      {change.was ? <s className="text-muted">{change.was}</s> : null}
      {change.was && change.now ? " " : ""}
      {change.now ? <span className="rounded-[3px] bg-[#FEF3C7] px-[3px] text-[#B45309]">{change.now}</span> : null}
      {change.after ? ` ${change.after}` : ""}
    </>
  );
}

const sentence = (c: Changed) => [c.before, c.now, c.after].filter(Boolean).join(" ");

// A line of plain text with the change's marks in place: a new column or rule lit green, a changed rule as above.
export function MarkedLine({ line, added, changed }: { line: string; added: string[]; changed: Changed[] }) {
  const c = changed.find((x) => line.includes(sentence(x)));
  if (c) {
    const at = line.indexOf(sentence(c));
    return (
      <>
        {line.slice(0, at)}
        <ChangedWords change={c} />
        {line.slice(at + sentence(c).length)}
      </>
    );
  }
  const a = added.find((x) => line.includes(x));
  if (!a) return <>{line}</>;
  const at = line.indexOf(a);
  return (
    <>
      {line.slice(0, at)}
      <Added>{a}</Added>
      <MarkedLine line={line.slice(at + a.length)} added={added.filter((x) => x !== a)} changed={changed} />
    </>
  );
}
