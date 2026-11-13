import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { typeCode } from "../mail";

// The 0.6 VM session only (UPDATE_STEP=build): a real build with the company's own key (Settings › AI), from words.
const URL = process.env.UPDATE_URL ?? "";
const COMPOSE = process.env.UPDATE_COMPOSE ?? "docker compose";
const ADMIN = process.env.UPDATE_ADMIN ?? "";
const at = (p: string) => new globalThis.URL(p, URL).toString();
const codeLine = new RegExp(`Sign-in code for ${ADMIN.replace(/\./g, "\\.")}: (\\w{3}-\\w{3})`);
const latest = () => [...execSync(`${COMPOSE} logs web --no-log-prefix`, { encoding: "utf8" }).matchAll(new RegExp(codeLine, "g"))].at(-1)?.[1];
const AI = { timeout: 300_000 };

test("a real build from words, with the company's own key", async ({ page }) => {
  test.skip(process.env.UPDATE_STEP !== "build");
  test.setTimeout(600_000);
  const before = latest();
  await page.goto(at("/login"));
  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect.poll(latest).not.toBe(before);
  await typeCode(page, latest()!);
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(/\/(setup|home)$/);
  await page.goto(at("/settings/ai"));
  await expect(page.getByText(/works/i).first()).toBeVisible();
  await page.screenshot({ path: "tmp/screens/vm-settings-ai.png" });
  // VM_CHAT: the chat whose plan the model already wrote (nothing asked again); otherwise a new request.
  if (process.env.VM_CHAT) await page.goto(at(`/home?chat=${process.env.VM_CHAT}`));
  else {
    await page.goto(at("/home"));
    await page.getByLabel(/Ask about your data|Describe a process/).fill(
      "We sign yearly contracts with customers. Track each contract: the customer, its value a year, start date, renewal date and owner, with steps Draft, Signed, Active and Ended.",
    );
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForURL(/\/home\?chat=/);
  }
  await expect(page.getByRole("button", { name: /^(Build all|Create)/ }).first()).toBeVisible(AI);
  await page.screenshot({ path: "tmp/screens/vm-build-plan.png" });
  await page.getByRole("button", { name: /^(Build all|Create)/ }).first().click();
  // A plan of several apps ends "Done. …"; one app ends with a link to it.
  await expect(page.getByText(/^Done\./).first().or(page.getByRole("link", { name: /^Open / }))).toBeVisible(AI);
  await expect(page.getByRole("complementary").getByRole("link", { name: /contract/i }).first()).toBeVisible();
  await page.screenshot({ path: "tmp/screens/vm-build-done.png" });
  await page.goto(at("/settings/ai"));
  await page.screenshot({ path: "tmp/screens/vm-settings-ai-after.png", fullPage: true });
});
