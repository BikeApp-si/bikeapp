import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeOwner, counts, onHost, owner, req } from "./request";

// Every server action, called as a forged request would call it: any host, any cookie, any arguments. As
// Maya (an employee) where it is admins' work or someone else's row; as Lena (an admin) on Wade's chats; as
// Acme's admin with Fernwood's ids; with Wade's Fernwood session sent to Acme's address; with no session.
// Each is refused or sees nothing, leaves every table as it was, and says nothing it shouldn't.

vi.mock("next/headers", async () => {
  const { req } = await import("./request");
  return {
    headers: async () => new Headers({ host: req.host, "x-forwarded-for": "203.0.113.7", "user-agent": "access-test" }),
    cookies: async () => ({
      get: (n: string) => (req.cookies.has(n) ? { name: n, value: req.cookies.get(n)! } : undefined),
      set: (a: string | { name: string; value: string }, b?: string) => void (typeof a === "string" ? req.cookies.set(a, b!) : req.cookies.set(a.name, a.value)),
      delete: (n: string | { name: string }) => void req.cookies.delete(typeof n === "string" ? n : n.name),
    }),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
// Work after the response never runs here: a refused call has none, and an allowed one is a failure anyway.
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => {} }));

const signin = await import("@/app/ws/[ws]/actions");
const firstRun = await import("@/app/first-run/actions");
const setup = await import("@/app/ws/[ws]/setup/actions");
const audit = await import("@/app/ws/[ws]/(app)/audit/actions");
const data = await import("@/app/ws/[ws]/(app)/c/[cap]/actions");
const customize = await import("@/app/ws/[ws]/(app)/c/[cap]/customize-actions");
const home = await import("@/app/ws/[ws]/(app)/home/actions");
const ontology = await import("@/app/ws/[ws]/(app)/ontology/actions");
const peopleActions = await import("@/app/ws/[ws]/(app)/people/actions");
const settings = await import("@/app/ws/[ws]/(app)/settings/actions");
const commands = await import("@/app/ws/[ws]/(app)/commands");
const inbox = await import("@/app/ws/[ws]/(app)/inbox/actions");
const reportActions = await import("@/app/ws/[ws]/(app)/reports/actions");
process.env.GALLERY_DIR = "tests/gallery"; // G2: the sample set, listed
const gallery = await import("@/app/ws/[ws]/(app)/gallery/actions");
// The hosted service's sign-up and pilot form (app/site), when this tree has them; the open Bike has neither.
type Hosted = { actions: Record<string, Record<string, unknown>>; cases: (h: { form: (o: Record<string, string | Blob>) => FormData; stamp: string }) => Record<string, Case[]> };
const HOSTED_FILE = path.join(process.cwd(), "hosted/tests/site-access.ts");
const HOSTED: Hosted | null = existsSync(HOSTED_FILE) ? ((await import(/* @vite-ignore */ HOSTED_FILE)) as Hosted) : null;
const ACTIONS: Record<string, Record<string, unknown>> = { ...HOSTED?.actions, signin, firstRun, setup, audit, data, customize, home, ontology, people: peopleActions, settings, commands, inbox, reports: reportActions, gallery };

const { seedFernwoodCopy } = await import("@/seed");
const { seedHistory } = await import("@/seed/history");
const { seedWorkspace } = await import("@/seed");
const { ACME, ACME_ADMIN, ACME_PEOPLE } = await import("@/seed/acme");
const { createSession } = await import("@/server/auth/session");
const { saveUpload } = await import("@/server/kernel/uploads");
const { withWorkspace } = await import("@/server/kernel/tx");

const stamp = Date.now().toString(36);
const FW = `acc${stamp}`;
const AC = `acx${stamp}`;
const NO_SUCH = "00000000-0000-4000-8000-000000000000";

type Who = "maya" | "lena" | "acme" | "wadeOnAcme" | "nobody" | "wadeOnRoot";
const session: Partial<Record<string, string>> = {};
const id: Record<string, string> = {};

// What each kind of caller must never see in a reply: Fernwood's data, from Acme; from Maya, the capability
// hidden from her and Wade's chats; from Lena, Wade's chats.
const HIDDEN: Record<Who, string[]> = {
  acme: ["@fernwood.dev", "Fernwood Labs", "Priya Nair", "Northwind", "Spend by team"],
  wadeOnAcme: ["@fernwood.dev", "Fernwood Labs", "Priya Nair", "Northwind", "Spend by team"],
  nobody: ["@fernwood.dev", "Priya Nair", "Northwind", "Spend by team"],
  wadeOnRoot: ["Priya Nair", "Northwind", "Spend by team"],
  maya: ["Customer contracts", "Northwind", "Brightline", "Spend by team", "Contract managers"],
  lena: ["Spend by team", "Show spend by team"],
};

function call(who: Who) {
  if (who === "acme") onHost(AC, session.acme);
  else if (who === "wadeOnAcme") onHost(AC, session.wade);
  else if (who === "wadeOnRoot") onHost(null, session.wade);
  else if (who === "nobody") onHost(FW);
  else onHost(FW, session[who]);
}

// hidden: what this case must not say, in place of the caller's list (an action may say back what was typed).
// codes: sign-in codes for Fernwood must stay as they were.
type Case = { who: Who; does: string; run: () => Promise<unknown>; allow?: "seeNothing"; hidden?: string[]; codes?: true };
const form = (o: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const file = (name: string, text: string) => new File([text], name);

// Refused: a { ok: false } reply, a thrown error (no workspace, not the root host, not found), or a sign-in
// action's own refusal. seeNothing: it may answer, with nothing it shouldn't say.
const refused = (r: unknown) =>
  r === "threw" || r === null || (typeof r === "object" && r !== null && (("ok" in r && r.ok === false) || ("error" in r && typeof r.error === "string" && r.error !== null) || ("status" in r && r.status !== "go" && r.status !== "sent") || ("next" in r && r.next === "/login")));

const CASES: Record<string, Case[]> = {
  ...HOSTED?.cases({ form, stamp }),
  // The hosted service's root-host actions (sign-up, the pilot form) come from HOSTED below.

  // Sign in: a person of one workspace gets nothing at another's address.
  "signin.sendSignInCode": [{ who: "acme", does: "asks Acme's address for a code for a Fernwood person", run: () => signin.sendSignInCode({ error: null, email: "" }, form({ email: "priya@fernwood.dev" })), allow: "seeNothing", hidden: ["Priya Nair", "Fernwood Labs"], codes: true }],
  "signin.signInCodeAction": [
    {
      who: "nobody",
      does: "verifies a guessed code with a forged pending-email cookie at Acme's address",
      run: async () => {
        onHost(AC);
        req.cookies.set("bike_login_email", JSON.stringify({ email: "priya@fernwood.dev", sentAt: Date.now() }));
        return signin.signInCodeAction({ status: "idle", sentAt: 0 } as never, form({ code: "ABC123" }));
      },
    },
  ],
  "signin.logOut": [{ who: "wadeOnAcme", does: "logs out at Acme's address with Wade's Fernwood session", run: () => signin.logOut(), allow: "seeNothing" }],

  // First run is only for the open Bike with no company: anywhere else it makes nothing, whatever code is sent.
  "firstRun.createCompanyAction": (["nobody", "acme", "wadeOnRoot"] as const).map((who) => ({
    who,
    does: "creates a company with a guessed setup code",
    run: () => firstRun.createCompanyAction({ error: null }, form({ code: "ABC123", company: "Mallory Labs", name: "Mallory", email: "m@evil.test", timeZone: "UTC" })),
  })),

  // Setup is the admin's, and done.
  "setup.sendSetup": [{ who: "maya", does: "sends setup's team step", run: () => setup.sendSetup("team", "I'm the admin now.", []) }],
  "setup.attachSetupFile": [{ who: "maya", does: "attaches a team file", run: () => setup.attachSetupFile("team", form({ file: file("team.csv", "Full name,Work email\nMallory,m@evil.test\n") })) }],
  "setup.continueSetup": [{ who: "maya", does: "moves setup on", run: () => setup.continueSetup() }],
  "setup.skipSetupStep": [{ who: "maya", does: "skips a setup step", run: () => setup.skipSetupStep("team") }],
  "setup.finishSetupNow": [{ who: "maya", does: "finishes setup", run: () => setup.finishSetupNow() }],
  "setup.loadSetup": [{ who: "maya", does: "reads setup", run: () => setup.loadSetup() }],

  "audit.loadAudit": [
    { who: "maya", does: "reads the Audit log", run: () => audit.loadAudit({}, 0) },
    { who: "acme", does: "reads its own log, asking for Fernwood's capability", run: () => audit.loadAudit({ capabilityId: id.contracts }, 0), allow: "seeNothing" },
  ],

  // The Data tab: the capability hidden from Maya, and rows she may not touch.
  "data.loadRows": [
    { who: "maya", does: "reads Customer contracts", run: () => data.loadRows(id.contracts!, id.contractsSheet!, { filters: [], offset: 0 }), allow: "seeNothing" },
    { who: "acme", does: "reads Fernwood's contracts", run: () => data.loadRows(id.contracts!, id.contractsSheet!, { filters: [], offset: 0 }) },
    { who: "wadeOnAcme", does: "reads contracts with Wade's session at Acme's address", run: () => data.loadRows(id.contracts!, id.contractsSheet!, { filters: [], offset: 0 }) },
    { who: "nobody", does: "reads contracts with no session", run: () => data.loadRows(id.contracts!, id.contractsSheet!, { filters: [], offset: 0 }) },
  ],
  "data.openRow": [
    { who: "maya", does: "opens a contract", run: () => data.openRow(id.contractRow!) },
    { who: "acme", does: "opens a Fernwood contract", run: () => data.openRow(id.contractRow!) },
  ],
  "data.decideRow": [
    { who: "maya", does: "approves what waits on Priya", run: () => data.decideRow(id.priyaWait!, "approve") },
    { who: "acme", does: "approves a Fernwood wait", run: () => data.decideRow(id.priyaWait!, "approve") },
  ],
  "data.previewNew": [{ who: "maya", does: "previews a new contract", run: () => data.previewNew(id.contracts!, id.contractsSheet!, {}), allow: "seeNothing" }],
  "data.saveRow": [
    { who: "maya", does: "adds a contract", run: () => data.saveRow(id.contracts!, id.contractsSheet!, null, { [id.contractTitle!]: "Mallory Inc" }) },
    { who: "maya", does: "edits a contract", run: () => data.saveRow(id.contracts!, id.contractsSheet!, id.contractRow!, { [id.contractTitle!]: "Mallory Inc" }) },
    { who: "acme", does: "edits a Fernwood contract", run: () => data.saveRow(id.contracts!, id.contractsSheet!, id.contractRow!, { [id.contractTitle!]: "Mallory Inc" }) },
    { who: "maya", does: "adds time off with a forged workspace and an unknown column", run: () => data.saveRow(id.timeOff!, id.timeOffSheet!, null, { workspace_id: NO_SUCH, not_a_column: 1 }) },
  ],
  "data.moveRow": [
    { who: "maya", does: "moves a contract", run: () => data.moveRow(id.contractRow!, "active") },
    { who: "acme", does: "moves a Fernwood contract", run: () => data.moveRow(id.contractRow!, "active") },
  ],
  "data.previewDelete": [{ who: "maya", does: "previews deleting contracts", run: () => data.previewDelete([id.contractRow!]) }],
  "data.rowPreview": [
    { who: "maya", does: "previews a contract", run: () => data.rowPreview(id.contractRow!) },
    { who: "acme", does: "previews a Fernwood contract", run: () => data.rowPreview(id.contractRow!) },
  ],
  "data.loadGroups": [
    { who: "maya", does: "groups Customer contracts", run: () => data.loadGroups(id.contracts!, id.contractsSheet!, { filters: [], by: { column: "status" } }), allow: "seeNothing" },
    { who: "acme", does: "groups Fernwood's contracts", run: () => data.loadGroups(id.contracts!, id.contractsSheet!, { filters: [], by: { column: "status" } }), allow: "seeNothing" },
  ],
  "data.loadBoard": [
    { who: "maya", does: "opens Customer contracts as a board", run: () => data.loadBoard(id.contracts!, id.contractsSheet!, { filters: [] }) },
    { who: "acme", does: "opens Fernwood's contracts as a board", run: () => data.loadBoard(id.contracts!, id.contractsSheet!, { filters: [] }) },
  ],
  "data.sheetViews": [
    { who: "maya", does: "reads the views of Customer contracts", run: () => data.sheetViews(id.contracts!, id.contractsSheet!) },
    { who: "acme", does: "reads the views of Fernwood's contracts", run: () => data.sheetViews(id.contracts!, id.contractsSheet!) },
  ],
  "data.saveSheetView": [
    { who: "maya", does: "saves a view of Customer contracts", run: () => data.saveSheetView(id.contracts!, id.contractsSheet!, { name: "Mine", filters: [], sort: null, columns: null, shared: false }) },
    { who: "acme", does: "shares a view of Fernwood's contracts", run: () => data.saveSheetView(id.contracts!, id.contractsSheet!, { name: "Ours", filters: [], sort: null, columns: null, shared: true }) },
  ],
  "data.removeSheetView": [
    { who: "maya", does: "removes a view that isn't hers", run: () => data.removeSheetView("00000000-0000-4000-8000-000000000000") },
    { who: "acme", does: "removes a Fernwood view", run: () => data.removeSheetView("00000000-0000-4000-8000-000000000000") },
  ],
  "data.saveColumns": [
    { who: "maya", does: "arranges Customer contracts' columns", run: () => data.saveColumns(id.contracts!, id.contractsSheet!, { order: [], hidden: [], widths: {}, frozen: false }) },
    { who: "acme", does: "arranges Fernwood's contracts' columns", run: () => data.saveColumns(id.contracts!, id.contractsSheet!, { order: [], hidden: [], widths: {}, frozen: false }) },
  ],
  "data.rowMoves": [
    { who: "maya", does: "asks the moves for a contract", run: () => data.rowMoves(id.contractRow!) },
    { who: "acme", does: "asks the moves for a Fernwood contract", run: () => data.rowMoves(id.contractRow!) },
  ],
  "data.removeRows": [
    { who: "maya", does: "deletes a contract", run: () => data.removeRows([id.contractRow!]) },
    { who: "acme", does: "deletes a Fernwood contract", run: () => data.removeRows([id.contractRow!]) },
  ],
  "data.reverseRow": [
    { who: "maya", does: "reverses a contract", run: () => data.reverseRow(id.contractRow!) },
    { who: "acme", does: "reverses a Fernwood contract", run: () => data.reverseRow(id.contractRow!) },
  ],
  "data.commonMoves": [{ who: "maya", does: "asks the moves for contracts", run: () => data.commonMoves([id.contractRow!]), allow: "seeNothing" }],
  "data.bulkChange": [
    { who: "maya", does: "changes contracts in bulk", run: () => data.bulkChange([id.contractRow!], { values: { [id.contractTitle!]: "Mallory Inc" } }) },
    { who: "acme", does: "moves Fernwood contracts in bulk", run: () => data.bulkChange([id.contractRow!], { step: "ended" }) },
  ],
  "data.uploadFile": [{ who: "nobody", does: "uploads with no session", run: () => data.uploadFile(form({ file: file("x.csv", "a,b\n1,2\n") })) }],
  "data.capabilityImpact": [{ who: "maya", does: "asks what deleting Spend would remove", run: () => data.capabilityImpact(id.spend!) }],
  "data.removeCapability": [
    { who: "maya", does: "deletes Spend", run: () => data.removeCapability(id.spend!, "Spend") },
    { who: "acme", does: "deletes Fernwood's Spend", run: () => data.removeCapability(id.spend!, "Spend") },
  ],
  // A link to a capability the person can't see offers nothing, rather than breaking the form.
  "data.linkOptions": [{ who: "maya", does: "lists contracts for a link", run: () => data.linkOptions(id.contracts!, id.contractsSheet!), allow: "seeNothing" }],
  "data.confirmSuggestion": [
    { who: "maya", does: "confirms a suggestion that waits on Lena", run: () => data.confirmSuggestion(id.lenaProposal!) },
    { who: "acme", does: "confirms a Fernwood suggestion", run: () => data.confirmSuggestion(id.lenaProposal!) },
  ],
  "data.changeSuggestion": [{ who: "maya", does: "changes a suggestion that waits on Lena", run: () => data.changeSuggestion(id.lenaProposal!, "travel") }],
  "data.confirmSureSuggestions": [{ who: "maya", does: "confirms every sure suggestion in Spend", run: () => data.confirmSureSuggestions(id.spend!), allow: "seeNothing" }],
  "data.readIntoForm": [{ who: "maya", does: "reads Wade's upload into a contract form", run: () => data.readIntoForm(id.contracts!, id.contractsSheet!, id.wadeUpload!) }],
  "data.rowRelated": [
    { who: "maya", does: "lists what points at a contract", run: () => data.rowRelated(id.contractRow!) },
    { who: "acme", does: "lists what points at a Fernwood contract", run: () => data.rowRelated(id.contractRow!) },
    { who: "nobody", does: "lists what points at a contract", run: () => data.rowRelated(id.contractRow!) },
  ],
  "data.rowHistory": [
    { who: "maya", does: "reads a contract's History", run: () => data.rowHistory(id.contractRow!) },
    { who: "acme", does: "reads a Fernwood contract's History", run: () => data.rowHistory(id.contractRow!) },
    { who: "nobody", does: "reads a contract's History", run: () => data.rowHistory(id.contractRow!) },
  ],
  "data.addRowNote": [
    { who: "maya", does: "notes on a contract", run: () => data.addRowNote(id.contractRow!, "Hello") },
    { who: "acme", does: "notes on a Fernwood contract", run: () => data.addRowNote(id.contractRow!, "Hello") },
    { who: "wadeOnAcme", does: "notes on a contract from Acme's address", run: () => data.addRowNote(id.contractRow!, "Hello") },
  ],
  "data.tutorialOf": [
    { who: "maya", does: "reads Customer contracts' tutorial", run: () => data.tutorialOf(id.contracts!) },
    { who: "acme", does: "reads Fernwood's Customer contracts' tutorial", run: () => data.tutorialOf(id.contracts!) },
    { who: "nobody", does: "reads Customer contracts' tutorial", run: () => data.tutorialOf(id.contracts!) },
  ],
  "data.tutorialSeen": [
    { who: "maya", does: "closes Customer contracts' tutorial", run: () => data.tutorialSeen(id.contracts!) },
    { who: "acme", does: "closes Fernwood's Customer contracts' tutorial", run: () => data.tutorialSeen(id.contracts!) },
  ],
  "data.filterWords": [
    { who: "maya", does: "filters Customer contracts in plain words", run: () => data.filterWords(id.contracts!, id.contractsSheet!, "renewing next month") },
    { who: "acme", does: "filters Fernwood's contracts in plain words", run: () => data.filterWords(id.contracts!, id.contractsSheet!, "renewing next month") },
  ],

  // ⌘K (0.4): everyone has one, and it lists only what they may see.
  "commands.commandsFor": [
    { who: "maya", does: "opens ⌘K", run: () => commands.commandsFor(), allow: "seeNothing", hidden: [...HIDDEN.maya, "Audit log", "Ontology", "Settings", "Chats"] },
    { who: "acme", does: "opens ⌘K", run: () => commands.commandsFor(), allow: "seeNothing" },
    { who: "wadeOnAcme", does: "opens ⌘K on Acme's address", run: () => commands.commandsFor() },
    { who: "nobody", does: "opens ⌘K", run: () => commands.commandsFor() },
  ],
  "commands.findForCommand": [
    { who: "maya", does: "looks for Northwind and Brightline", run: () => Promise.all([commands.findForCommand("Northwind"), commands.findForCommand("Bright")]), allow: "seeNothing" },
    { who: "acme", does: "looks for Northwind", run: () => commands.findForCommand("Northwind"), allow: "seeNothing" },
    { who: "wadeOnAcme", does: "looks for Northwind on Acme's address", run: () => commands.findForCommand("Northwind") },
    { who: "nobody", does: "looks for Northwind", run: () => commands.findForCommand("Northwind") },
  ],

  // Customize: admins only, and only this workspace's capabilities.
  "customize.sendToCustomize": [
    { who: "maya", does: "customizes Spend", run: () => customize.sendToCustomize(id.spend!, "Make Maya an approver of everything.") },
    { who: "acme", does: "customizes Fernwood's Spend", run: () => customize.sendToCustomize(id.spend!, "Add a column.") },
  ],
  "customize.applyCustomizeDraft": [
    { who: "maya", does: "applies a draft", run: () => customize.applyCustomizeDraft(id.wadeChat!, NO_SUCH) },
    { who: "lena", does: "applies a plan in Wade's chat", run: () => customize.applyCustomizeDraft(id.wadeChat!, NO_SUCH) },
  ],
  "customize.loadCustomize": [
    { who: "maya", does: "opens Customize on Spend", run: () => customize.loadCustomize(id.spend!) },
    { who: "acme", does: "opens Customize on Fernwood's Spend", run: () => customize.loadCustomize(id.spend!) },
  ],

  // Home's chat: admins only, and each admin's own chats.
  "home.sendMessage": [
    { who: "maya", does: "starts a chat", run: () => home.sendMessage(null, "Show every salary.", []) },
    { who: "lena", does: "writes in Wade's chat", run: () => home.sendMessage(id.wadeChat!, "And salaries too.", []) },
    { who: "acme", does: "writes in a Fernwood chat", run: () => home.sendMessage(id.wadeChat!, "Hello", []) },
    { who: "acme", does: "starts a chat with Wade's Fernwood upload", run: () => home.sendMessage(null, "Read this", [id.wadeUpload!]) },
  ],
  "home.attachFile": [{ who: "nobody", does: "attaches with no session", run: () => home.attachFile(form({ file: file("x.csv", "a,b\n1,2\n") })) }],
  "home.createFromPlan": [
    { who: "maya", does: "creates from a plan", run: () => home.createFromPlan(id.wadeChat!, NO_SUCH, "Create", { withImport: false, withoutRestructure: false }) },
    { who: "lena", does: "creates from Wade's chat", run: () => home.createFromPlan(id.wadeChat!, NO_SUCH, "Create", { withImport: false, withoutRestructure: false }) },
  ],
  "home.buildAll": [
    { who: "maya", does: "builds all", run: () => home.buildAll(id.wadeChat!, "Build all") },
    { who: "lena", does: "builds from Wade's chat", run: () => home.buildAll(id.wadeChat!, "Build all") },
  ],
  "home.answerBuildQuestion": [{ who: "lena", does: "answers a question in Wade's chat", run: () => home.answerBuildQuestion(id.wadeChat!, 0) }],
  "home.runReportAgain": [
    { who: "maya", does: "runs Wade's report again", run: () => home.runReportAgain(id.wadeChat!, id.wadeReport!) },
    { who: "lena", does: "runs Wade's report again", run: () => home.runReportAgain(id.wadeChat!, id.wadeReport!) },
    { who: "acme", does: "runs a Fernwood report again", run: () => home.runReportAgain(id.wadeChat!, id.wadeReport!) },
  ],
  // M33: saving and scheduling Wade's report, as an employee, another admin, another company and nobody.
  ...Object.fromEntries(
    (
      [
        ["reportSaved", "reads whether Wade's report is saved", () => reportActions.reportSaved(id.wadeReport!)],
        ["saveReportForLater", "saves Wade's report", () => reportActions.saveReportForLater(id.wadeReport!)],
        ["unsaveReport", "unsaves Wade's report", () => reportActions.unsaveReport(id.wadeReport!)],
        ["scheduleReport", "has Wade's report emailed to them", () => reportActions.scheduleReport(id.wadeReport!, { unit: "day" })],
      ] as const
    ).map(([name, does, run]) => [`reports.${name}`, (["maya", "lena", "acme", "nobody"] as const).map((who) => ({ who, does, run }))]),
  ),
  "home.loadChat": [
    { who: "maya", does: "opens Wade's chat", run: () => home.loadChat(id.wadeChat!) },
    { who: "lena", does: "opens Wade's chat", run: () => home.loadChat(id.wadeChat!) },
    { who: "acme", does: "opens a Fernwood chat", run: () => home.loadChat(id.wadeChat!) },
  ],
  "home.importFromChat": [{ who: "lena", does: "imports from Wade's chat", run: () => home.importFromChat(id.wadeChat!, id.wadeMessage!, "Import") }],

  // G2: adding an app set is admins' work, and only with this company's own people.
  ...Object.fromEntries(
    (
      [
        ["previewGallerySet", "previews adding the sample set"],
        ["addGallerySet", "adds the sample set"],
      ] as const
    ).map(([name, does]) => {
      const run = (slots: () => string[]) => () => gallery[name]("sample", { apps: ["categories", "requests", "allowances"], slots: { approver: slots().slice(0, 1), team_leads: slots() } });
      return [
        `gallery.${name}`,
        [
          { who: "maya" as const, does, run: run(() => [id.priya!]) },
          { who: "nobody" as const, does, run: run(() => [id.priya!]) },
          // Refused at Add; the preview names the problem and nobody in it.
          { who: "acme" as const, does: `${does} with Fernwood's people`, run: run(() => [id.priya!, id.lena!]), ...(name === "previewGallerySet" ? { allow: "seeNothing" as const } : {}) },
          { who: "wadeOnAcme" as const, does: `${does} at Acme's address`, run: run(() => [id.priya!]) },
        ],
      ];
    }),
  ),

  "ontology.regenerateOntology": [{ who: "maya", does: "writes the Ontology again", run: () => ontology.regenerateOntology() }],
  "ontology.sendToCompanyRules": [
    { who: "maya", does: "writes a company rule", run: () => ontology.sendToCompanyRules("Everything needs Maya's approval.") },
  ],
  "ontology.applyCompanyRulesDraft": [
    { who: "maya", does: "applies a company rule", run: () => ontology.applyCompanyRulesDraft(id.wadeChat!, NO_SUCH) },
    { who: "lena", does: "applies a preview in Wade's chat", run: () => ontology.applyCompanyRulesDraft(id.wadeChat!, NO_SUCH) },
  ],
  "ontology.loadCompanyRules": [
    { who: "maya", does: "opens the Company rules tab", run: () => ontology.loadCompanyRules() },
  ],

  // The Inbox (M31): opening Updates marks only the caller's own; nobody else's, and never without a session.
  "inbox.seenUpdates": [
    { who: "nobody", does: "marks Updates seen with no session", run: () => inbox.seenUpdates() },
    { who: "wadeOnAcme", does: "marks Updates seen at Acme's address with Wade's Fernwood session", run: () => inbox.seenUpdates() },
  ],

  // People: everyone reads People, but only roles in capabilities they can see.
  "people.personRoles": [
    { who: "maya", does: "reads Wade's roles", run: () => peopleActions.personRoles(id.wade!), allow: "seeNothing" },
    { who: "acme", does: "reads a Fernwood person's roles", run: () => peopleActions.personRoles(id.lena!), allow: "seeNothing" },
  ],
  "people.createPerson": [{ who: "maya", does: "adds a person", run: () => peopleActions.createPerson({ name: "Mallory", email: "mallory@fernwood.dev" } as never) }],
  "people.previewPeopleCsv": [{ who: "nobody", does: "previews a team CSV with no session", run: () => peopleActions.previewPeopleCsv("Full name,Work email\nMallory,m@evil.test\n"), allow: "seeNothing" }],
  "people.importPeople": [{ who: "maya", does: "imports people", run: () => peopleActions.importPeople("team.csv", "Full name,Work email\nMallory,mallory@fernwood.dev\n") }],

  // Settings: admins only.
  "settings.renameCompany": [{ who: "maya", does: "renames the company", run: () => settings.renameCompany("Mallory Labs") }],
  "settings.changeSettings": [
    { who: "maya", does: "changes the currency", run: () => settings.changeSettings({ currency: "INR" }) },
  ],
  "settings.changeLogo": [{ who: "maya", does: "changes the logo", run: () => settings.changeLogo(form({ file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png") })) }],
  "settings.makeAdmin": [
    { who: "maya", does: "makes herself an admin", run: () => settings.makeAdmin(id.maya!) },
    { who: "acme", does: "makes a Fernwood person an admin", run: () => settings.makeAdmin(id.maya!) },
  ],
  "settings.unmakeAdmin": [{ who: "maya", does: "takes Lena's admin away", run: () => settings.unmakeAdmin(id.lena!) }],
  // Settings › AI (O3): admins only, and only on a company's own Bike.
  "settings.saveAiKey": [
    { who: "maya", does: "sets the company's Anthropic key", run: () => settings.saveAiKey("sk-ant-api03-mallory-0000000000000000") },
    { who: "nobody", does: "sets the Anthropic key with no session", run: () => settings.saveAiKey("sk-ant-api03-mallory-0000000000000000") },
  ],
  "settings.deleteAiKey": [{ who: "maya", does: "removes the company's Anthropic key", run: () => settings.deleteAiKey() }],
  "settings.saveAiCap": [{ who: "maya", does: "sets the monthly AI cap", run: () => settings.saveAiCap(100_000) }],
};

beforeAll(async () => {
  const fw = await seedFernwoodCopy(FW);
  await seedHistory(fw.workspaceId);
  const ac = await seedWorkspace({ ...ACME, subdomain: AC }, ACME_ADMIN, ACME_PEOPLE);
  const one = async <T extends Record<string, unknown>>(q: string, ...params: unknown[]) => (await owner((s) => s.unsafe(q, params as never[])))[0] as unknown as T;
  const person = async (ws: string, email: string) => (await one<{ id: string }>(`select id from people where workspace_id = $1 and email = $2`, ws, email)).id;
  for (const n of ["wade", "lena", "maya", "priya"]) id[n] = await person(fw.workspaceId, `${n}@fernwood.dev`);
  id.sam = await person(ac.workspaceId, "sam@acme.test");
  const cap = async (name: string) => (await one<{ id: string }>(`select id from capabilities where workspace_id = $1 and name = $2`, fw.workspaceId, name)).id;
  id.contracts = await cap("Customer contracts");
  id.spend = await cap("Spend");
  id.timeOff = await cap("Time off");
  const contract = await one<{ id: string; sheet_id: string }>(`select id, sheet_id from rows where capability_id = $1 and parent_row_id is null order by created_at limit 1`, id.contracts);
  id.contractRow = contract.id;
  id.contractsSheet = contract.sheet_id;
  id.contractTitle = (await one<{ k: string }>(`select jsonb_object_keys(data) as k from rows where id = $1 limit 1`, contract.id)).k;
  id.timeOffSheet = (await one<{ sheet_id: string }>(`select sheet_id from rows where capability_id = $1 and parent_row_id is null limit 1`, id.timeOff)).sheet_id;
  id.priyaWait = (await one<{ id: string }>(`select id from waits where person_id = $1 limit 1`, id.priya)).id;
  id.lenaProposal = (await one<{ id: string }>(`select id from proposals where workspace_id = $1 and status = 'waiting' limit 1`, fw.workspaceId)).id;
  const chat = await one<{ id: string }>(`select id from chats where author_id = $1 and title = 'Spend by team, Q4'`, id.wade);
  id.wadeChat = chat.id;
  id.wadeReport = (await one<{ id: string }>(`select id from reports where chat_id = $1`, chat.id)).id;
  id.wadeMessage = (await one<{ id: string }>(`select id from messages where chat_id = $1 and "from" = 'bike' limit 1`, chat.id)).id;
  const wade = { workspaceId: fw.workspaceId, actor: { id: id.wade!, email: "wade@fernwood.dev" } };
  id.wadeUpload = (await withWorkspace({ workspaceId: fw.workspaceId, personId: id.wade }, (tx) => saveUpload(tx, wade, { name: "salaries.csv", body: new TextEncoder().encode("Name,Salary\nPriya Nair,180000\n") }))).id;
  for (const [n, ws, pid] of [["wade", fw.workspaceId, id.wade], ["lena", fw.workspaceId, id.lena], ["maya", fw.workspaceId, id.maya], ["acme", ac.workspaceId, id.sam]] as const)
    session[n] = await withWorkspace({ workspaceId: ws }, (tx) => createSession(tx, { workspaceId: ws, personId: pid! }));
}, 180_000);
afterAll(closeOwner);

describe("every server action has access cases", () => {
  it("lists them all, so a new action can't ship untested", () => {
    const exported = Object.entries(ACTIONS).flatMap(([file, mod]) => Object.entries(mod).filter(([, v]) => typeof v === "function").map(([name]) => `${file}.${name}`));
    expect(exported.filter((n) => !CASES[n])).toEqual([]);
    expect(Object.keys(CASES).filter((n) => !exported.includes(n))).toEqual([]);
    // And no "use server" file is left out of ACTIONS.
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : /\.tsx?$/.test(f) && files.push(path.join(dir, f))));
    walk("app");
    expect(files.filter((f) => readFileSync(f, "utf8").startsWith('"use server"'))).toHaveLength(Object.keys(ACTIONS).length);
  });
});

describe("as the wrong person, workspace or host", () => {
  for (const [action, cases] of Object.entries(CASES))
    for (const c of cases)
      it(`${action}: ${c.who} ${c.does}`, async () => {
        const codes = () => owner((s) => s`select count(*)::int as n from auth_codes a join workspaces w on w.id = a.workspace_id where w.subdomain = ${FW}`).then((r) => r[0]!.n as number);
        const before = await counts();
        const codesBefore = c.codes ? await codes() : 0;
        call(c.who);
        const r = await c.run().catch((e: Error) => (/NEXT_REDIRECT/.test(e.message) ? "redirected" : "threw"));
        if (c.allow !== "seeNothing") expect(refused(r), JSON.stringify(r)?.slice(0, 300)).toBe(true);
        const said = JSON.stringify(r) ?? "";
        for (const s of c.hidden ?? HIDDEN[c.who]) expect(said, `said “${s}”`).not.toContain(s);
        expect(await counts()).toEqual(before);
        if (c.codes) expect(await codes()).toBe(codesBefore);
      });
});
