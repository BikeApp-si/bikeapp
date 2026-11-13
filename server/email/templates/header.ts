import { edition } from "@/edition";

// The mark at the top of every email: the company's logo once an admin has uploaded one in Settings, Bike's B
// until then (and for sign-up, before the company exists). Images by address, as email needs; the logo's
// upload id in the address makes a new logo a new image.
export function markUrl(company: { subdomain: string; logoId: string | null } | null): string {
  return company?.logoId ? edition.workspaceUrl(company.subdomain, `/logo?v=${company.logoId}`) : edition.emailLogoUrl();
}

export function markImg(src: string): string {
  return `<img src="${src}" alt="" height="40" style="display:block;height:40px;width:auto;max-width:160px;border:0;border-radius:10px">`;
}
