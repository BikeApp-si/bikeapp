import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { typeCode } from "../mail";

// The 0.6 VM session only (UPDATE_STEP=notice): Settings › Instance on a 0.6.0 install says 0.6.1 is out.
const URL = process.env.UPDATE_URL ?? "";
const COMPOSE = process.env.UPDATE_COMPOSE ?? "docker compose";
const ADMIN = process.env.UPDATE_ADMIN ?? "";
const at = (p: string) => new globalThis.URL(p, URL).toString();
const codeLine = new RegExp(`Sign-in code for ${ADMIN.replace(/\./g, "\\.")}: (\\w{3}-\\w{3})`);
const latest = () => [...execSync(`${COMPOSE} logs web --no-log-prefix`, { encoding: "utf8" }).matchAll(new RegExp(codeLine, "g"))].at(-1)?.[1];

test("Settings › Instance: a newer version is out", async ({ page }) => {
  test.skip(process.env.UPDATE_STEP !== "notice");
  const before = latest();
  await page.goto(at("/login"));
  await page.getByLabel("Work email").fill(ADMIN);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect.poll(latest).not.toBe(before);
  await typeCode(page, latest()!);
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(/\/(setup|home)$/);
  await page.goto(at("/settings/instance"));
  await expect(page.getByText("Bike 0.6.1 is out.")).toBeVisible();
  await expect(page.getByRole("link", { name: "What changed" })).toHaveAttribute("href", "https://github.com/BikeApp-si/bikeapp/releases/tag/v0.6.1");
  await expect(page.getByText("To update, run sh update.sh 0.6.1 on the server.")).toBeVisible();
  await page.screenshot({ path: "tmp/screens/vm-instance-0.6.1-out.png" });
});
