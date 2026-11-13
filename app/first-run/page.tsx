import { connection } from "next/server";
import { FirstRunForm } from "@/components/auth/first-run-form";
import { instanceUrl } from "@/server/edition/open";
import { ensureSetupCode } from "@/server/kernel/instance";
import { createCompanyAction } from "./actions";

// The open Bike before its company exists (the proxy sends every address here). A setup code is waiting in the log.
export default async function FirstRunPage() {
  await connection();
  await ensureSetupCode();
  return <FirstRunForm host={instanceUrl().host} action={createCompanyAction} />;
}
