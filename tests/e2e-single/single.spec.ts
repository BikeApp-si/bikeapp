import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { STEP6 } from "../step6";
import { codeFor, mailSeen, typeCode } from "../mail";
import { at, SINGLE_DATABASE_ADMIN_URL, SINGLE_PORT } from "./env";

// The open Bike (BIKE_MODE=single): Fernwood alone at localhost:3200. People sign in at that address, work in their
// apps and Customize them as on the hosted service; no website, sign-up, trial or other address is there.
test.describe.configure({ mode: "serial" });

const AI = { timeout: 30_000 };

async function signIn(page: Page, email: string) {
  const sql = postgres(SINGLE_DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
  await sql`delete from rate_limit_events`;
  await sql.end();
  await page.goto(at("/login"));
  const sentAfter = await mailSeen(email);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({ timeout: 15_000 });
  await typeCode(page, await codeFor(email, sentAfter));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(at("/home"));
}

test("the sign-in page has no website links and no Create a company", async ({ page }) => {
  await page.goto(at("/login"));
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  for (const name of ["Create a company", "Security", "Privacy", "Terms"]) await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("Maya signs in at the company's address and asks for time off", async ({ page }) => {
  await signIn(page, "maya@fernwood.dev");
  await page.getByRole("link", { name: /^Time off/ }).click();
  await page.getByRole("link", { name: "Request time off" }).click();
  const form = page.getByRole("dialog", { name: "Request time off" });
  await form.getByRole("radio", { name: "Vacation" }).click();
  await form.getByLabel("From").fill("Dec 7, 2026");
  await form.getByLabel("To").fill("Dec 9, 2026");
  await form.getByLabel("Note").fill("Single company week off");
  await form.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("row", { name: /Dec 7–9.*3.*Vacation.*Submitted/ })).toBeVisible();
  // No credits for anyone, and Docs goes to bikeapp.si/docs.
  await expect(page.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://bikeapp.si/docs");
});

// O3: with no Anthropic key, what needs a model says so plainly, and everything else works (docs/design/o3/).
test("with no AI key, Home, Customize and filters say what needs a model; Maya sees no Help", async ({ page }) => {
  await signIn(page, "wade@fernwood.dev");
  await expect(page.getByText("Building apps from words or documents, and asking about your data, need an AI model.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Start from an app set" })).toHaveAttribute("href", "/gallery");
  await expect(page.getByPlaceholder(/Ask about your data/)).toHaveCount(0);
  await page.getByRole("link", { name: "Customer contracts" }).first().click();
  await page.getByRole("button", { name: /^Filter/ }).first().click();
  await expect(page.getByText("Filters in plain words need an AI model. Pick a question below to filter by hand.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Customize" }).click();
  await expect(page.getByText("Changing an app from words needs an AI model, and this Bike has none yet.")).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveCount(0);
  await page.goto(at("/settings/ai"));
  // Fernwood's seed has AI calls this month (October, the flows' day): they show, in dollars.
  await expect(page.getByText(/^This month · Oct 1–27/)).toBeVisible();
  await expect(page.getByText("Without a key")).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, "maya@fernwood.dev");
  await page.getByRole("link", { name: /^Time off/ }).click();
  await expect(page.getByRole("button", { name: "Help" })).toHaveCount(0);
});

test("Wade adds the company's key in Settings › AI, then customizes Customer contracts from the recorded answers", async ({ page }) => {
  await signIn(page, "wade@fernwood.dev");
  await page.goto(at("/settings/ai"));
  await page.getByLabel("Anthropic key").fill("sk-ant-api03-e2e-single-0000000000004f2a");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("sk-ant-…4f2a")).toBeVisible();
  await expect(page.getByText(/^Set here\./)).toBeVisible();
  await page.goto(at("/home"));
  await page.getByRole("link", { name: "Customer contracts" }).first().click();
  await page.getByRole("tab", { name: "Customize" }).click();
  await expect(page.getByText("How Customer contracts works")).toBeVisible();
  await page.getByLabel("Message").fill(STEP6.legal);
  await page.getByRole("button", { name: "Send" }).click();
  const apply = page.getByRole("button", { name: /^Apply \d+ changes$/ });
  await expect(apply).toBeVisible(AI);
  await apply.click();
  await expect(page.getByText("Done. Customer contracts is at version 5.")).toBeVisible(AI);
  // No AI credits above an admin's name: the open Bike has none.
  await expect(page.getByText(/credits/i)).toHaveCount(0);
});

test("Wade sees the instance's health in Settings › Instance; Maya can't open it", async ({ page }) => {
  await signIn(page, "wade@fernwood.dev");
  await page.goto(at("/settings"));
  await page.getByRole("tab", { name: "Instance" }).click();
  await page.waitForURL(at("/settings/instance"));
  // The tabs as the Ontology's outlined buttons, the open one marked (docs/design/o6/settings-tabs.png).
  await expect(page.getByRole("tab", { name: "Instance" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Company" })).toHaveAttribute("aria-selected", "false");
  await page.screenshot({ path: "tmp/screens/o6-settings-tabs.png" });
  await expect(page.getByText(`http://localhost:${SINGLE_PORT}`)).toBeVisible();
  for (const name of ["Database", "File storage", "Virus scanner", "Email", "Clock", "AI"]) await expect(page.locator(`[data-health="${name}"]`)).toHaveAttribute("data-ok", "true");
  await expect(page.getByText("On this server’s disk. A test file was saved, read and removed.")).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeEnabled();
  await page.context().clearCookies();
  await signIn(page, "maya@fernwood.dev");
  expect((await page.goto(at("/settings/instance")))?.status()).toBe(404);
});

test("no website, sign-up, trial or other address is reachable", async ({ page }) => {
  const x4 = async (url: string) => {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(404);
  };
  for (const path of ["/signup", "/signup?invite=e2e-k7p2qx9m", "/apply", "/pricing", "/docs", "/site", "/site/signup", "/ws/fernwood/home", "/credits"]) await x4(at(path));
  for (const host of [`fernwood.localhost:${SINGLE_PORT}`, `www.localhost:${SINGLE_PORT}`, `127.0.0.1:${SINGLE_PORT}`]) {
    await x4(`http://${host}/`);
    await x4(`http://${host}/login`);
    await expect(page.getByRole("heading", { name: "No workspace at this address" })).toBeVisible();
  }
});
