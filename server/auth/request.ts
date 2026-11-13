import { headers } from "next/headers";
import type { RequestMeta } from "./signin";

// IP, browser and (when the host sends one) city for rate limits and the code email.
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const ip = h.get("fly-client-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "local";
  const city = h.get("cf-ipcity") ?? h.get("x-vercel-ip-city");
  return { ip, userAgent: h.get("user-agent"), city: city ? decodeURIComponent(city) : null };
}
