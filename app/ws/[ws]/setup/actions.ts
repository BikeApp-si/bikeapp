"use server";
import { mustBeAdmin } from "@/server/kernel/admin";

import { after } from "next/server";
import { asAction } from "@/server/auth/kernel-call";
import { readPdf } from "@/server/files/read";
import { readSpreadsheet, SheetError } from "@/server/files/sheet-reader";
import { KernelError } from "@/server/kernel/context";
import { saveUpload } from "@/server/kernel/uploads";
import { continueToTeam, finishSetup, sendOrganization, sendTeam, skipOrganization, skipTeam, type Work } from "@/server/setup/flow";
import { setupView } from "@/server/setup/view";

// Setup 2b–2f (admins): each call is a kernel call as the signed-in person. Prompt 8 reads a message after
// the response, so the page shows Bike working as it polls.

export async function sendSetup(step: "organization" | "team", text: string, uploadIds: string[]) {
  let work: Work | undefined;
  const r = await asAction(async (tx, ctx) => {
    work = await (step === "organization" ? sendOrganization : sendTeam)(tx, ctx, text, uploadIds);
    return {};
  });
  if (r.ok && work) after(work);
  return r;
}

// A file for this step, with what its chip says ("team.xlsx · 14 rows", "policy.pdf · 3 pages").
export async function attachSetupFile(step: "organization" | "team", form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "Choose a file.", problems: [] };
  const body = new Uint8Array(await file.arrayBuffer());
  return asAction(async (tx, ctx) => {
    await mustBeAdmin(tx, ctx); // setup is the admin's; nothing is read or kept for anyone else
    let detail: string;
    if (step === "organization") {
      if (!/\.pdf$/i.test(file.name)) throw new KernelError("On this step Bike reads PDFs.");
      const { pages } = await readPdf(body);
      detail = `${pages} ${pages === 1 ? "page" : "pages"}`;
    } else {
      const rows = await readSpreadsheet(file.name, body).catch((e) => Promise.reject(e instanceof SheetError ? new KernelError(e.message) : e));
      detail = `${rows.length - 1} ${rows.length === 2 ? "row" : "rows"}`;
    }
    const u = await saveUpload(tx, ctx, { name: file.name, body });
    return { uploadId: u.id, name: u.name, detail };
  });
}

export async function continueSetup() {
  return asAction(async (tx, ctx) => (await continueToTeam(tx, ctx), {}));
}

export async function skipSetupStep(step: "organization" | "team") {
  return asAction(async (tx, ctx) => (await (step === "organization" ? skipOrganization : skipTeam)(tx, ctx), {}));
}

export async function finishSetupNow() {
  return asAction(async (tx, ctx) => (await finishSetup(tx, ctx), {}));
}

export async function loadSetup() {
  return asAction(async (tx, ctx) => ({ view: await setupView(tx, ctx) }));
}
