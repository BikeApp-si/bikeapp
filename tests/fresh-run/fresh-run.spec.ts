import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { codeFor, mailSeen, typeCode } from "../mail";

// O2's Done when: the open Bike from its image on empty volumes (scripts/fresh-run.sh). First run with the setup code
// from the log, the first admin signs in (code by email through Mailpit, or from the log with no relay), and
// Settings › Instance shows each item; a stopped scanner fails and says how to fix it.
test.describe.configure({ mode: "serial" });

const URL = process.env.FRESH_URL ?? "http://localhost:3300";
const RELAY = process.env.FRESH_RELAY === "mailpit";
const COMPOSE = process.env.FRESH_COMPOSE ?? "docker compose";
const at = (p: string) => new globalThis.URL(p, URL).toString();
const ADMIN = `rita.${RELAY ? "relay" : "norelay"}.${Date.now().toString(36)}@juniper.dev`;

const logs = () => execSync(`${COMPOSE} logs web --no-log-prefix`, { encoding: "utf8" });
const fromLog = (pattern: RegExp) => [...logs().matchAll(new RegExp(pattern, "g"))].at(-1)?.[1];

async function signInCode(page: Page, seen: Set<string> | null) {
  if (seen) return codeFor(ADMIN, seen);
  await expect.poll(() => fromLog(new RegExp(`Sign-in code for ${ADMIN.replace(/\./g, "\\.")}: (\\w{3}-\\w{3})`))).toBeTruthy();
  return fromLog(new RegExp(`Sign-in code for ${ADMIN.replace(/\./g, "\\.")}: (\\w{3}-\\w{3})`))!;
}

test("first run creates the company, and its first admin signs in", async ({ page }) => {
  await page.goto(at("/"));
  await expect(page.getByRole("heading", { name: "Set up your Bike" })).toBeVisible();
  const code = fromLog(/Setup code for this Bike: (\w{3}-\w{3})\./);
  expect(code, "a setup code in Bike's log").toBeTruthy();
  // A wrong code first: it says so, and counts down.
  const fill = async (setup: string) => {
    await typeCode(page, setup);
    await page.getByLabel("Company name").fill("Juniper Outfitters");
    await page.getByLabel("Your name").fill("Rita Founder");
    await page.getByLabel("Work email").fill(ADMIN);
    await page.getByRole("button", { name: "Create company" }).click();
  };
  await fill((code!.startsWith("A") ? "B" : "A") + code!.slice(1));
  await expect(page.getByText("That code isn’t right. 4 tries left.")).toBeVisible();

  await page.reload();
  const seen = RELAY ? await mailSeen(ADMIN) : null;
  await fill(code!);
  await page.waitForURL(at("/code"));
  await expect(page.getByRole("heading", { name: RELAY ? "Check your email" : "Find your code in the log" })).toBeVisible();
  await typeCode(page, await signInCode(page, seen));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(at("/setup"));

  // The setup code no longer leads anywhere: the address is the company's now.
  await page.goto(at("/"));
  await page.waitForURL(at("/setup"));
});

test("Settings › Instance shows each item; a stopped scanner says how to fix it", async ({ page }) => {
  const seen = RELAY ? await mailSeen(ADMIN) : null;
  await page.goto(at("/login"));
  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(at("/code"));
  await typeCode(page, await signInCode(page, seen));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(/\/(setup|home)$/);

  await page.goto(at("/settings/instance"));
  const item = (name: string) => page.locator(`[data-health="${name}"]`);
  for (const name of ["Database", "File storage", "Virus scanner", "Clock"]) await expect(item(name)).toHaveAttribute("data-ok", "true");
  await expect(item("File storage")).toContainText("On this server’s disk.");
  await expect(item("Email")).toHaveAttribute("data-ok", String(RELAY));
  if (!RELAY) await expect(item("Email")).toContainText("Set SMTP_URL in .env and restart Bike.");
  await expect(item("AI")).toHaveAttribute("data-ok", "false");
  await expect(item("AI")).toContainText("Add your company’s key in Settings › AI.");
  await expect(page.getByText(URL.replace(/\/$/, ""))).toBeVisible();
  await expect(page.getByText("fresh", { exact: true })).toBeVisible(); // the image's version

  execSync(`${COMPOSE} stop clamav`);
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(item("Virus scanner")).toHaveAttribute("data-ok", "false");
  await expect(item("Virus scanner")).toContainText("Start it with docker compose up -d clamav.");
  execSync(`${COMPOSE} start clamav`);
});
