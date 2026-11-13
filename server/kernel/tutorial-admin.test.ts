import { describe, expect, it } from "vitest";
import type { AccessSummary, SheetSummary } from "./access-summary";
import { checkTutorial, type Tutorial } from "./tutorial";

// S1 (0.55): an admin's "can't" names only what nobody can do here, a limit the access summary itself has. The lines
// are the ones E1's recording wrote for admins: true ones are kept, ones an admin can do are refused.

const sheet = (name: string, more: Partial<SheetSummary> = {}): SheetSummary => ({
  name,
  one: name.toLowerCase(),
  many: `${name.toLowerCase()}s`,
  sees: "all",
  add: `Add ${name.toLowerCase()}`,
  edit: true,
  delete: true,
  steps: [],
  movesFrom: [],
  movesTo: [],
  stepRules: [],
  columns: ["Name"],
  ...more,
});
const admin = (...sheets: SheetSummary[]): AccessSummary => ({ capability: "App", admin: true, view: null, sheets, rules: [] });
const page = (...cannot: string[]): Tutorial => ({ purpose: "What it's for.", steps: [{ title: "Look", text: "Look.", does: { kind: "read", sheet: "Requests", step: null } }], waits: [], cannot });
const refused = (line: string) => `“${line}”: this person is an admin and can do this; leave it out of cannot.`;

const requests = sheet("Requests", { steps: ["Submitted", "Approved", "Declined"], movesFrom: ["Submitted"], movesTo: ["Approved", "Declined"], stepRules: ["Approved: not by the person who submitted the request"] });

describe("an admin's can't", () => {
  it("keeps a ledger's entries that can't be changed", () => {
    const s = admin(requests, sheet("Leave entries", { edit: false, delete: false, reverse: true }));
    expect(checkTutorial(s, page("You can't change the leave entries once they are recorded."))).toEqual([]);
  });

  it("keeps a dated sheet's rows in force that can't be changed", () => {
    const s = admin(requests, sheet("Rates", { dated: true }));
    expect(checkTutorial(s, page("You can't change a rate that is already in force."))).toEqual([]);
  });

  it("keeps approving their own, and refuses approving at all when only their own is barred", () => {
    const s = admin(requests);
    expect(checkTutorial(s, page("You can't approve or decline your own request."))).toEqual([]);
    expect(checkTutorial(s, page("You can't approve or reject time entries here."))).toEqual([refused("You can't approve or reject time entries here.")]);
  });

  it("keeps the same limits in other words (E1 and S1's recordings)", () => {
    const s = admin(requests, sheet("Fee entries", { add: null, edit: false, delete: false, reverse: false }));
    const lines = ["You can't decide a concession you asked for yourself.", "Nobody can approve or reject a purchase or expense they submitted themselves.", "Fee entries can't be reversed."];
    expect(checkTutorial(s, page(...lines))).toEqual([]);
  });

  it("keeps sheets nobody adds to or deletes from", () => {
    const s = admin(requests, sheet("Fee cards", { add: null, edit: false, delete: false }));
    expect(checkTutorial(s, page("You can't add or change fee cards here.", "You can't delete a fee card."))).toEqual([]);
  });

  it("refuses what the admin can do: adding, reversing, moving on, seeing only their own", () => {
    const s = admin(requests, sheet("Moves", { edit: false, delete: false, reverse: true }));
    const lines = ["You can't add a move yourself; moves are recorded by the system.", "You can't reverse a move from this list.", "You can't move requests on once they are submitted.", "You see only your own balance."];
    expect(checkTutorial(s, page(...lines))).toEqual(lines.map(refused));
  });

  it("refuses any can't for an admin with no limits", () => {
    const s = admin(sheet("Requests"));
    expect(checkTutorial(s, page("You can't delete a request."))).toEqual([refused("You can't delete a request.")]);
    expect(checkTutorial(s, page())).toEqual([]);
  });
});
