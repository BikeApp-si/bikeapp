import { expect, type Page } from "@playwright/test";

// Codes and emails in Mailpit, for the browser flows (tests/e2e and tests/e2e-single).

export type Mail = { ID: string; Subject: string };
export async function mailTo(to: string): Promise<Mail[]> {
  const res = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await res.json()) as { messages: Mail[] }).messages;
}

// One email in full, as Mailpit holds it: who it's from and to, Reply-To, and its text.
export async function mailMessage(id: string): Promise<{ Subject: string; Text: string; ReplyTo: { Address: string }[]; To: { Address: string }[] }> {
  return (await fetch(`http://localhost:8025/api/v1/message/${id}`)).json();
}

// The emails this address already has, taken before a code is sent: the code is in the first one after.
// (By id, not time: Mailpit's clock in Docker can lag the machine's by more than a second.)
export async function mailSeen(to: string): Promise<Set<string>> {
  return new Set((await mailTo(to)).map((m) => m.ID));
}

// The code in the newest code email this address got after `seen`. Other new emails are skipped: the worker's
// "… is ready" emails from an earlier flow can land just after the code and were read in its place.
export async function codeFor(to: string, seen: Set<string>): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const code = (await mailTo(to))
      .filter((m) => !seen.has(m.ID))
      .map((m) => m.Subject.match(/Your Bike code: (\w{3}-\w{3})/)?.[1])
      .find(Boolean);
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No code email for ${to}`);
}

// Typed again until the boxes split it: typed before the page is hydrated, it all stays in the first box.
export async function typeCode(page: Page, code: string) {
  await expect(async () => {
    await page.getByLabel("Character 1").fill(code.replace("-", ""));
    await expect(page.getByLabel("Character 6")).not.toHaveValue("", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
