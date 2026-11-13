import { NextResponse, type NextRequest } from "next/server";
import { edition } from "@/edition";
import { workspaceBySubdomain } from "@/server/kernel/workspaces";
import { sessionCookie, redeemHandoff } from "@/server/auth/session";

// Sign up lands here on the new subdomain: the one-time token becomes a session on this host, and setup
// carries on at 2b.
export async function GET(request: NextRequest) {
  const route = await edition.route(request.headers.get("host"));
  const ws = route.kind === "workspace" ? await workspaceBySubdomain(route.subdomain) : null;
  const token = request.nextUrl.searchParams.get("t");
  const session = ws && token ? await redeemHandoff(ws.id, token) : null;
  const to = (path: string) => new URL(path, `${request.nextUrl.protocol}//${request.headers.get("host")}`);
  if (!session) return NextResponse.redirect(to("/login"));
  const res = NextResponse.redirect(to("/setup"));
  res.cookies.set(sessionCookie(session));
  return res;
}
