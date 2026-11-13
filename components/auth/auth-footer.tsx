"use client";

import { createContext, useContext } from "react";

export type FooterLink = { label: string; href: string };

// The links below the sign-in card, set once in the root layout from the edition (hosted: Security, Privacy,
// Terms on bikeapp.si; the open Bike: none). A context, so client cards (the code form, error pages) show them too.
const Links = createContext<FooterLink[]>([]);

export function AuthFooterLinks({ links, children }: { links: FooterLink[]; children: React.ReactNode }) {
  return <Links.Provider value={links}>{children}</Links.Provider>;
}

export function AuthFooter() {
  const links = useContext(Links);
  if (!links.length) return null;
  return (
    <footer className="flex gap-4 pt-6 text-[15px] text-muted">
      {links.map((l) => (
        <a key={l.label} href={l.href}>
          {l.label}
        </a>
      ))}
    </footer>
  );
}
