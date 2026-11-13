import { cn } from "@/lib/utils";

// Buttons as the screens draw them: 36 px (28 px small), 6 px radius, 15 px medium text.
type Kind = "primary" | "outline" | "danger" | "ghost";
const KINDS: Record<Kind, string> = {
  primary: "border-0 bg-primary text-white hover:bg-primary-hover disabled:bg-primary-border",
  outline: "border border-line bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page",
  danger: "border-0 bg-[#DC2626] text-white hover:bg-[#B91C1C] disabled:bg-[#FCA5A5]",
  ghost: "border-0 bg-transparent font-normal text-muted hover:bg-fill hover:text-ink",
};

// An outlined button as a link (the Ontology's Download, Settings' tabs): white, a 1 px line, a faint shadow, 32 px.
export const OUTLINED =
  "inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page";

export function Button({ kind = "outline", small, className, ...props }: { kind?: Kind; small?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] text-[15px] font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-focus disabled:cursor-default",
        small ? "h-7 px-2.5" : "h-9 px-3.5",
        KINDS[kind],
        className,
      )}
      {...props}
    />
  );
}

// A 30 px square icon button (Delete, Close).
export function IconButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-icon outline-none hover:bg-fill focus-visible:ring-3 focus-visible:ring-focus", className)}
      {...props}
    />
  );
}
