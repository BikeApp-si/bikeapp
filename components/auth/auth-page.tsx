import { BikeMark } from "@/components/logo";
import { AuthFooter } from "./auth-footer";
import { cn } from "@/lib/utils";


// The centred card used by 1a–1d, the root log in and X4, with the edition's links below it (AuthFooter).
export function AuthPage({ width, className, children }: { width: 380 | 400 | 420; className?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-4 py-10 text-[#09090B]">
      <section
        style={{ width }}
        className={cn("flex max-w-full flex-col gap-4 rounded-[12px] border border-line bg-white p-8", className)}
      >
        {children}
      </section>
      <AuthFooter />
    </main>
  );
}

// The company's logo on its own address once an admin uploads one (`logo`, from companyLogo); Bike's B until then.
export function AuthHeading({ title, logo, children }: { title: string; logo?: string | null; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className="h-10 w-auto max-w-[160px] rounded-[10px] object-contain" />
      ) : (
        <BikeMark size={40} />
      )}
      <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
      {children ? <p className="m-0 text-base leading-normal text-muted">{children}</p> : null}
    </div>
  );
}
