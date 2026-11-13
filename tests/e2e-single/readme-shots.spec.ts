import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { codeFor, mailSeen, typeCode } from "../mail";
import { at, SINGLE_DATABASE_ADMIN_URL } from "./env";

// The open Bike's README pictures, from the open Bike itself (Fernwood, Wade signed in), at 2×. Taken only when
// README_SHOTS names the folder they go to:
//   README_SHOTS=hosted/export/repo/docs/images pnpm e2e:single readme-shots
// Nothing is saved (the key the pictures need is removed after); real captures, never edited.
const DIR = process.env.README_SHOTS;
test.skip(!DIR, "README_SHOTS names the folder for the README's pictures");
test.use({ deviceScaleFactor: 2 });
test.describe.configure({ mode: "serial" });

async function signInAsWade(page: Page) {
  const email = "wade@fernwood.dev";
  const sql = postgres(SINGLE_DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
  await sql`delete from rate_limit_events`;
  await sql.end();
  await page.goto(at("/login"));
  const sentAfter = await mailSeen(email);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await typeCode(page, await codeFor(email, sentAfter));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(at("/home"));
}

async function shot(page: Page, name: string) {
  mkdirSync(DIR!, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(DIR!, `${name}.png`) });
}

async function contracts(page: Page) {
  await page.goto(at("/home"));
  await page.getByRole("link", { name: "Customer contracts" }).first().click();
  await expect(page.getByRole("cell", { name: "Lumen Retail", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signInAsWade(page);
  // Customize and Home's chat need a model: the e2e key (recorded answers only), if it isn't set yet.
  await page.goto(at("/settings/ai"));
  const field = page.getByLabel("Anthropic key");
  if (await field.isVisible()) {
    await field.fill("sk-ant-api03-e2e-single-0000000000004f2a");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("sk-ant-…4f2a")).toBeVisible();
  }
});

// The key goes again, so the other flows find the Bike as they expect it (with no key, until they add one).
test.afterAll(async () => {
  const sql = postgres(SINGLE_DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
  await sql`update instance_settings set ai_key_sealed = null, ai_key_last4 = null`;
  await sql.end();
});

test("Home", async ({ page }) => {
  await page.goto(at("/home"));
  await expect(page.getByRole("heading").first()).toBeVisible();
  await shot(page, "home");
});

test("a sheet as a table", async ({ page }) => {
  await contracts(page);
  await shot(page, "table");
});

test("a row's record", async ({ page }) => {
  await contracts(page);
  await page.getByRole("cell", { name: "Lumen Retail", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Lumen Retail" }).getByRole("tab", { name: "Details" })).toBeVisible();
  await shot(page, "record");
});

test("Customize, with the app as a picture", async ({ page }) => {
  await contracts(page);
  await page.getByRole("tab", { name: "Customize" }).click();
  await expect(page.getByText("How Customer contracts works")).toBeVisible();
  const picture = page.getByRole("tab", { name: "Picture" }).or(page.getByRole("button", { name: "Picture" }));
  if (await picture.first().isVisible()) await picture.first().click();
  await shot(page, "customize");
});
