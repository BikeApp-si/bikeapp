import type { Tx } from "@/server/kernel/tx";

// What differs between the Bike a company runs for itself (open.ts) and the hosted service (hosted/edition.ts).
// Open code imports `edition` from "@/edition" and never anything hosted; tsconfig picks which file that is.

// Where a host leads: a company's workspace (by its address), the website (hosted only), the open Bike's first run
// (no company yet), or nowhere (X4; `companies` when the open Bike's database holds more than one).
export type Route = { kind: "workspace"; subdomain: string } | { kind: "site" } | { kind: "firstRun" } | { kind: "none"; companies?: number };

export type Link = { label: string; href: string };

export type Edition = {
  // One company at one address (the open Bike, or bikeapp.si's build with BIKE_MODE=single): first run, Settings ›
  // Instance, and no mail relay unless SMTP_URL is set.
  oneCompany(): boolean;
  // Whether sign-in cookies are sent over HTTPS only. The open Bike follows its address: a plain-http address on a
  // company's network still signs people in (browsers drop secure cookies over http).
  secureCookies(): boolean;
  route(host: string | null | undefined): Promise<Route>;
  // A page of a company's Bike, as a full address (emails, sign-up's hand-off).
  workspaceUrl(subdomain: string, path?: string): string;
  // Bike's B at the top of an email, before a company uploads its logo.
  emailLogoUrl(): string;
  // The sidebar's Docs link; null hides it.
  docsUrl(): string | null;
  // Below the sign-in card (Security, Privacy, Terms); empty hides them.
  authFooter(): Link[];
  // "New to Bike? Create a company" on a company's sign-in page; null hides it.
  createCompanyUrl(): string | null;
  // Before a call that builds something new: a plain reason it can't run now, or null.
  beforeBuild(workspaceId: string): Promise<string | null>;
  // What a call costs in credits, logged with it (0 where there are no credits).
  creditsFor(costUsd: number): number;
  // What admins see above their name in the sidebar; null shows nothing.
  adminCredits(tx: Tx): Promise<{ left: number; total: number } | null>;
  // Where a reply to Bike's email goes when the email doesn't say; null: to the sender.
  replyTo(): string | null;
  // A new company's trial end; null: no trial.
  trialEndsAt(createdAt: Date): Date | null;
  // The page for an address with nothing on it, off a company's address; null: X4's card.
  siteNotFound(): Promise<React.ReactNode> | null;
};
