import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { typeCode } from "../mail";

// O4's Done when, in a browser (scripts/update-run.sh drives the installs and runs this after each step):
// UPDATE_STEP=install: first run, the first admin signs in and uploads the company's logo (a file on disk).
// UPDATE_STEP=check: the same admin signs in, and the company, its logo and the running version are all there.
// No mail relay: sign-in codes come from Bike's log.

const URL = process.env.UPDATE_URL ?? "http://localhost:3300";
const COMPOSE = process.env.UPDATE_COMPOSE ?? "docker compose";
const ADMIN = process.env.UPDATE_ADMIN ?? "rita@juniper.dev";
const VERSION = process.env.UPDATE_VERSION ?? "0.6.0";
const at = (p: string) => new globalThis.URL(p, URL).toString();
// A 1×1 PNG.
const LOGO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const logs = () => execSync(`${COMPOSE} logs web --no-log-prefix`, { encoding: "utf8" });
const fromLog = (pattern: RegExp) => [...logs().matchAll(new RegExp(pattern, "g"))].at(-1)?.[1];
const codeLine = new RegExp(`Sign-in code for ${ADMIN.replace(/\./g, "\\.")}: (\\w{3}-\\w{3})`);

async function signIn(page: Page) {
  const before = fromLog(codeLine);
  await page.goto(at("/login"));
  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(at("/code"));
  await expect.poll(() => fromLog(codeLine)).not.toBe(before);
  await typeCode(page, fromLog(codeLine)!);
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(/\/(setup|home)$/);
}

const logo = (page: Page) => page.locator('img[alt="Logo"]');

test("install: first run, and a logo uploaded", async ({ page }) => {
  test.skip(process.env.UPDATE_STEP !== "install");
  await page.goto(at("/"));
  const code = fromLog(/Setup code for this Bike: (\w{3}-\w{3})\./);
  expect(code, "a setup code in Bike's log").toBeTruthy();
  await typeCode(page, code!);
  await page.getByLabel("Company name").fill("Juniper Outfitters");
  await page.getByLabel("Your name").fill("Rita Founder");
  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByRole("button", { name: "Create company" }).click();
  await page.waitForURL(at("/code"));
  await expect.poll(() => fromLog(codeLine)).toBeTruthy();
  await typeCode(page, fromLog(codeLine)!);
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(at("/setup"));

  await page.goto(at("/settings"));
  await page.locator('input[type="file"][accept=".png,.jpg,.jpeg"]').setInputFiles({ name: "juniper.png", mimeType: "image/png", buffer: LOGO });
  await expect(logo(page)).toHaveJSProperty("naturalWidth", 1);
});

test("check: the company, its logo and the version", async ({ page }) => {
  test.skip(process.env.UPDATE_STEP !== "check");
  await signIn(page);
  await page.goto(at("/settings"));
  await expect(page.getByText("Juniper Outfitters").first()).toBeVisible();
  await expect(logo(page)).toHaveJSProperty("naturalWidth", 1);
  await page.goto(at("/settings/instance"));
  await expect(page.getByText(VERSION, { exact: true })).toBeVisible();
  for (const name of ["Database", "File storage", "Backups"]) await expect(page.locator(`[data-health="${name}"]`)).toHaveAttribute("data-ok", "true");
});
