import { NextResponse, type NextRequest } from "next/server";
import { edition } from "@/edition";
import { fullHealth } from "@/server/health";

// Host → workspace, as the edition says. Hosted: the root host serves app/site, a workspace host app/ws/[ws],
// anything else X4. The open Bike: its one address serves its one company, anything else X4.
// The host only picks the workspace: every workspace page checks the session belongs to it too.

const INTERNAL = /^\/(site|ws|no-workspace|first-run)(\/|$)/;

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Fly's health check, on any host (it calls the machine's own address).
  if (pathname === "/healthz") return new NextResponse("ok", { status: 200 });
  // The uptime monitor's deeper check: the database and the virus scanner (DEPLOY.md).
  if (pathname === "/healthz/full") {
    const health = await fullHealth();
    return new NextResponse(health.body, { status: health.status, headers: { "cache-control": "no-store" } });
  }
  // The internal folders are never reachable by their own path, on any host.
  if (INTERNAL.test(pathname)) return new NextResponse(null, { status: 404 });

  const route = await edition.route(request.headers.get("host"));
  const to = (path: string) => NextResponse.rewrite(new URL(`${path}${search}`, request.url));

  if (route.kind === "site") return to(`/site${pathname === "/" ? "" : pathname}`);
  if (route.kind === "workspace") return to(`/ws/${route.subdomain}${pathname === "/" ? "" : pathname}`);
  // The open Bike before its company exists: every address is the first-run page (a-first-run.png).
  if (route.kind === "firstRun") return NextResponse.rewrite(new URL("/first-run", request.url));
  // The open Bike's database holds more than one company: none is served, and the card says why (d-x4-many-companies).
  if (route.companies) return NextResponse.rewrite(new URL(`/no-workspace/many/${route.companies}`, request.url), { status: 503 });
  // Not found, with the page: so bots and search engines don't take an unknown address for a real one.
  return NextResponse.rewrite(new URL(`/no-workspace${search}`, request.url), { status: 404 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|email-logo.png|og.png).*)"],
};
