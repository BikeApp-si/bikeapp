import { cn } from "@/lib/utils";

// Inputs and buttons as the screens draw them (36 px high, 6 px radius).
export const inputClass =
  "h-9 w-full rounded-[6px] border border-line bg-white px-3 text-base text-[#09090B] shadow-[0_1px_2px_rgba(0,0,0,.05)] outline-none focus:border-primary focus:shadow-[0_0_0_3px_#DCEEFF]";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[15px] text-muted">
      {label}
      {children}
      {hint ? <span className="text-[13.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function PrimaryButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "h-9 w-full cursor-pointer rounded-[6px] bg-primary text-base font-medium text-white shadow-[0_1px_2px_rgba(15,92,168,.25)] hover:bg-primary-hover disabled:cursor-default disabled:opacity-45 disabled:hover:bg-primary",
        className,
      )}
    />
  );
}

export function Divider() {
  return <div className="h-px bg-line" />;
}

// Violet links with a light underline, as on the screens.
export const linkClass = "text-primary-deep underline decoration-primary-border underline-offset-[3px] hover:decoration-primary-deep";

export function ErrorText({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("m-0 text-center text-[15px] text-danger", className)}>{children}</p>;
}
