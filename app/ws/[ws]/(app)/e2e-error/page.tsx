import { notFound } from "next/navigation";
import { connection } from "next/server";
import { isE2E } from "@/server/kernel/clock";

// Playwright's way to see the error page: this page fails on purpose in its own build, and isn't there anywhere else.
export default async function E2EError() {
  await connection();
  if (!isE2E()) notFound();
  throw new Error("A failure on purpose, for the error page's test");
}
