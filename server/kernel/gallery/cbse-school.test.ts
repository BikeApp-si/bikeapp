import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { getFile } from "../capabilities";
import { companyRules } from "../company-rules";
import { linkOptionTitles, namesFor } from "../views";
import { createRow, getRow, listRows, moveStep, updateRow } from "../rows";
import { runDateRules, systemCtx } from "../date-rules";
import { waitingFor } from "../waiting";
import { addSet, previewSet } from "./add";
import { checkSet } from "./check";
import { loadSet } from "./format";

// G3 · The CBSE school set (gallery/cbse-school), added to a test company and run through its main days in the
// kernel: an admission becomes a student with a fee card, fees are charged, paid and conceded through the ledger,
// an unexplained absence waits on the class teacher, a report card gets its grades, and class teachers see only
// their own section. Priya is the principal, Rita the office, Omar the accountant, Maya a teacher; Maya is class
// teacher of 6 A and Omar of 6 B.

const set = () => loadSet(path.join(process.cwd(), "gallery/cbse-school"));
const APPS = ["students", "admissions", "fees", "attendance", "exams", "staff_leave"];
type K = Awaited<ReturnType<typeof kernelWorkspace>>;
const slots = (k: K) => ({ principal: [k.id.priya], office: [k.id.rita], accountant: [k.id.omar], teachers: [k.id.maya] });
const at = (d: string) => new Date(`${d}T06:00:00Z`);

describe("the CBSE school set", () => {
  it("passes the set's check", () => {
    const r = checkSet(set());
    expect(r.ok ? [] : r.problems).toEqual([]);
  });

  it("can't add Fees without Classes and students", async () => {
    const k = await kernelWorkspace();
    const p = await k.as("ada", (tx, c) => previewSet(tx, c, set(), { apps: ["fees"], slots: slots(k) }));
    expect(p.problems).toContain("Fees needs Classes and students, so add them together.");
  });

  it("names its four slots and adds its company rule", async () => {
    const k = await kernelWorkspace();
    const p = await k.as("ada", (tx, c) => previewSet(tx, c, set(), { apps: APPS, slots: slots(k) }));
    expect(p.problems).toEqual([]);
    expect(p.slots.map((s) => s.name)).toEqual(["Principal", "Office", "Accountant", "Teachers"]);
    expect(p.alsoChanges).toContain("Ontology › Company rules: adds “Every new student gets a fee card for the year.”");
  });
});

describe("a school's days", () => {
  let k: K;
  let app: Record<string, string>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    k = await kernelWorkspace();
    const added = await k.as("ada", (tx, c) => addSet(tx, c, set(), { apps: APPS, slots: slots(k) }), at("2026-04-01"));
    app = Object.fromEntries(added.apps.map((a) => [a.key, a.id]));
    const add = (sheet: string, values: Record<string, unknown>) => k.as("rita", (tx, c) => createRow(tx, c, app.students!, sheet, { values }), at("2026-04-01"));
    ids.class6 = (await add("classes", { name: "Class 6" })).id;
    ids.class7 = (await add("classes", { name: "Class 7" })).id;
    ids.a6 = (await add("classes", { name: "6 A", parent: ids.class6, class_teacher: k.id.maya })).id;
    ids.b6 = (await add("classes", { name: "6 B", parent: ids.class6, class_teacher: k.id.omar })).id;
    // ₹54,000 a year for Class 6 from April 2026, in four instalments.
    await k.as("omar", (tx, c) =>
      createRow(tx, c, app.fees!, "structures", {
        values: { class: ids.class6, from: "2026-04-01", tuition: 4_800_000, annual: 600_000, due_1: "2026-04-10", due_2: "2026-07-10", due_3: "2026-10-10", due_4: "2027-01-10" },
      }),
    );
  });

  const student = (name: string, section: string) =>
    k.as("rita", (tx, c) => createRow(tx, c, app.students!, "students", { values: { name, class: ids.class6, section, dob: "2014-06-02", phone: "+91 98450 00000" } }), at("2026-04-02"));
  const cardOf = async (studentId: string, when = "2026-04-02") => {
    const cards = await k.as("omar", (tx, c) => listRows(tx, c, app.fees!, "cards"), at(when));
    return cards.find((r) => r.data.student === studentId)!;
  };

  it("an admitted child becomes a student, without a section yet, with a fee card charged for the year", async () => {
    const appl = await k.as("rita", (tx, c) => createRow(tx, c, app.admissions!, "applications", { values: { child: "Aarav Sharma", class: ids.class6, dob: "2014-05-11", phone: "+91 98450 12345", father: "Rohit Sharma" } }), at("2026-04-02"));
    for (const step of ["interaction", "offered", "admitted"]) await k.as("rita", (tx, c) => moveStep(tx, c, appl.id, step), at("2026-04-02"));

    const students = await k.as("rita", (tx, c) => listRows(tx, c, app.students!, "students"), at("2026-04-02"));
    const aarav = students.find((s) => s.data.name === "Aarav Sharma")!;
    expect(aarav.data).toMatchObject({ class: ids.class6, father: "Rohit Sharma", dob: "2014-05-11" });
    expect(aarav.data.section).toBeUndefined();

    const card = await cardOf(aarav.id);
    expect(card.data).toMatchObject({ class: ids.class6, year_fee: 5_400_000, owing: 5_400_000 });
    ids.aarav = aarav.id;
  });

  it("a section from another class is refused", async () => {
    const other = await k.as("rita", (tx, c) => createRow(tx, c, app.students!, "classes", { values: { name: "7 A", parent: ids.class7 } }), at("2026-04-02"));
    await expect(student("Wrong Section", other.id)).rejects.toThrow(/The section is in the class/);
  });

  it("a payment and an approved concession lower what's owing; the fee due by now follows the instalments", async () => {
    const card = await cardOf(ids.aarav!);
    await k.as("omar", (tx, c) => createRow(tx, c, app.fees!, "payments", { values: { receipt_no: "R-0001", card: card.id, amount: 1_350_000, mode: "upi" } }), at("2026-04-08"));
    // More than what's owing is refused.
    await expect(k.as("omar", (tx, c) => createRow(tx, c, app.fees!, "payments", { values: { receipt_no: "R-0002", card: card.id, amount: 9_000_000, mode: "cash" } }), at("2026-04-08"))).rejects.toThrow(/owing/);

    const asked = await k.as("omar", (tx, c) => createRow(tx, c, app.fees!, "concessions", { values: { card: card.id, amount: 270_000, reason: "sibling" } }), at("2026-04-08"));
    expect((await cardOf(ids.aarav!, "2026-04-08")).data.owing).toBe(4_050_000);
    expect((await k.as("priya", (tx, c) => waitingFor(tx, c), at("2026-04-08"))).map((w) => w.label)).toContain("Approve or decline");
    await k.as("priya", (tx, c) => moveStep(tx, c, asked.id, "approved"), at("2026-04-09"));

    const after = await cardOf(ids.aarav!, "2026-07-11");
    expect(after.data.owing).toBe(3_780_000);
    // Two instalments of ₹13,500 are due by Jul 11; ₹13,500 paid and ₹2,700 conceded leave ₹10,800 overdue.
    expect(after.data.due_now).toBe(2_700_000);
    expect(after.data.overdue).toBe(1_080_000);
    expect(after.data.last_due).toBe("2026-07-10");
  });

  it("a week after an instalment is due, the accountant hears about overdue fees", async () => {
    const tick = (day: string) => k.as("ada", (tx) => runDateRules(tx, systemCtx(k.workspaceId, at(day)), { capabilityId: app.fees! }));
    expect(await tick("2026-07-16")).toEqual({ ran: 0 });
    const cards = await k.as("omar", (tx, c) => listRows(tx, c, app.fees!, "cards"), at("2026-07-17"));
    const overdue = cards.filter((r) => (r.data.overdue as number) > 0);
    expect(overdue.length).toBeGreaterThan(0);
    expect(await tick("2026-07-17")).toEqual({ ran: overdue.length });
    expect(await tick("2026-07-18")).toEqual({ ran: 0 });
  });

  it("an absence with no known reason waits on the class teacher until the parents are called", async () => {
    const riya = await student("Riya Iyer", ids.a6!);
    const absent = await k.as("maya", (tx, c) => createRow(tx, c, app.attendance!, "absences", { values: { student: riya.id, section: ids.a6 } }), at("2026-04-03"));
    const maya = await k.as("maya", (tx, c) => waitingFor(tx, c), at("2026-04-03"));
    expect(maya.map((w) => [w.title, w.label])).toContainEqual(["Riya Iyer", "Call the parents"]);
    await k.as("maya", (tx, c) => updateRow(tx, c, absent.id, { parents_called_on: "2026-04-03" }), at("2026-04-03"));
    expect((await k.as("maya", (tx, c) => waitingFor(tx, c), at("2026-04-03"))).map((w) => w.label)).not.toContain("Call the parents");
    // A sick day waits on nobody.
    await k.as("maya", (tx, c) => createRow(tx, c, app.attendance!, "absences", { values: { student: riya.id, section: ids.a6, date: "2026-04-06", reason: "sick" } }), at("2026-04-06"));
    expect((await k.as("maya", (tx, c) => waitingFor(tx, c), at("2026-04-06"))).map((w) => w.label)).not.toContain("Call the parents");
    ids.riya = riya.id;
  });

  it("class teachers see only their own section's students and absences", async () => {
    const kabir = await student("Kabir Rao", ids.b6!);
    await k.as("omar", (tx, c) => createRow(tx, c, app.attendance!, "absences", { values: { student: kabir.id, section: ids.b6, reason: "family" } }), at("2026-04-03"));
    const names = async (who: "maya" | "omar") => (await k.as(who, (tx, c) => listRows(tx, c, app.students!, "students"), at("2026-04-03"))).map((r) => r.data.name);
    expect(await names("maya")).toContain("Riya Iyer");
    expect(await names("maya")).toContain("Kabir Rao"); // Maya is also a teacher, who sees every student
    const omarAbsences = await k.as("omar", (tx, c) => listRows(tx, c, app.attendance!, "absences"), at("2026-04-03"));
    expect(omarAbsences.map((r) => r.data.student)).toEqual([kabir.id]);
    // Maya can't mark an absence in 6 B.
    await expect(k.as("maya", (tx, c) => createRow(tx, c, app.attendance!, "absences", { values: { student: kabir.id, section: ids.b6 } }), at("2026-04-03"))).rejects.toThrow();
  });

  it("a report card's subjects get totals and CBSE grades; the principal issues it", async () => {
    const saved = await k.as("maya", (tx, c) => createRow(tx, c, app.exams!, "report_cards", { values: { student: ids.riya, section: ids.a6, year: "2026–27", term: "term_1" } }), at("2026-09-30"));
    const MARKS: [string, number, number][] = [["english", 18, 74], ["mathematics", 15, 52], ["science", 9, 22], ["hindi", 8, 20]];
    for (const [subject, internal, exam] of MARKS)
      await k.as("maya", (tx, c) => createRow(tx, c, app.exams!, "marks", { values: { report_card: saved.id, subject, internal, exam } }), at("2026-09-30"));
    const lines = await k.as("maya", (tx, c) => listRows(tx, c, app.exams!, "marks"), at("2026-09-30"));
    expect(lines.map((l) => [l.data.total, l.data.grade])).toEqual([[92, "A1"], [67, "B2"], [31, "E"], [28, "E"]]);
    const card = await k.as("maya", (tx, c) => getRow(tx, c, saved.id), at("2026-09-30"));
    expect(card.data).toMatchObject({ marks: 218, out_of: 400, section: ids.a6 });

    // A report card is titled by its student: pickers and linked fields read the student's name, never an id.
    const options = await k.as("maya", async (tx, c) => linkOptionTitles(tx, c, (await getFile(tx, app.exams!))!.file.sheets.find((s) => s.id === "report_cards")!, await listRows(tx, c, app.exams!, "report_cards")), at("2026-09-30"));
    expect(options).toEqual([{ id: saved.id, label: "Riya Iyer" }]);
    const names = await k.as("maya", async (tx, c) => namesFor(tx, c, (await getFile(tx, app.exams!))!.file.sheets.find((s) => s.id === "marks")!, lines), at("2026-09-30"));
    expect(names.rows[saved.id]).toBe("Riya Iyer");
    // Omar can't see Riya's report card, so he isn't told its title.
    const hidden = await k.as("omar", async (tx, c) => namesFor(tx, c, (await getFile(tx, app.exams!))!.file.sheets.find((s) => s.id === "marks")!, lines), at("2026-09-30"));
    expect(hidden.rows[saved.id]).toBeUndefined();

    await k.as("maya", (tx, c) => moveStep(tx, c, saved.id, "checked"), at("2026-09-30"));
    // The class teacher can't issue it; the principal does.
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, saved.id, "issued"), at("2026-09-30"))).rejects.toThrow();
    expect((await k.as("priya", (tx, c) => waitingFor(tx, c), at("2026-09-30"))).map((w) => w.label)).toContain("Check and issue");
    await k.as("priya", (tx, c) => moveStep(tx, c, saved.id, "issued"), at("2026-10-01"));
    // Omar, class teacher of 6 B, doesn't see 6 A's report card or its marks, and can't add marks to it.
    expect(await k.as("omar", (tx, c) => listRows(tx, c, app.exams!, "report_cards"), at("2026-10-01"))).toEqual([]);
    expect(await k.as("omar", (tx, c) => listRows(tx, c, app.exams!, "marks"), at("2026-10-01"))).toEqual([]);
    await expect(k.as("omar", (tx, c) => createRow(tx, c, app.exams!, "marks", { values: { report_card: saved.id, subject: "art", internal: 20, exam: 80 } }), at("2026-10-01"))).rejects.toThrow();
  });

  it("an issued transfer certificate fills the student's Left on", async () => {
    const tc = await k.as("rita", (tx, c) => createRow(tx, c, app.students!, "tcs", { values: { student: ids.aarav, leaving_on: "2027-03-31", reason: "moving" } }), at("2027-03-20"));
    // The office can't issue it; it waits on the principal, who does.
    await expect(k.as("rita", (tx, c) => moveStep(tx, c, tc.id, "issued"), at("2027-03-20"))).rejects.toThrow();
    expect((await k.as("priya", (tx, c) => waitingFor(tx, c), at("2027-03-20"))).map((w) => w.label)).toContain("Issue or cancel");
    await k.as("priya", (tx, c) => moveStep(tx, c, tc.id, "issued"), at("2027-03-21"));
    const aarav = await k.as("rita", (tx, c) => getRow(tx, c, ids.aarav!), at("2027-03-21"));
    expect(aarav.data.left_on).toBe("2027-03-31");
  });

  it("staff leave waits on the principal; a substitute is told; each teacher sees only their own leave", async () => {
    const leave = await k.as("maya", (tx, c) => createRow(tx, c, app.staff_leave!, "leave", { values: { type: "casual", from: "2026-08-03", to: "2026-08-04" } }), at("2026-07-28"));
    expect((await k.as("maya", (tx, c) => getRow(tx, c, leave.id), at("2026-07-28"))).data.days).toBe(2);
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, leave.id, "approved"), at("2026-07-28"))).rejects.toThrow();
    expect((await k.as("priya", (tx, c) => waitingFor(tx, c), at("2026-07-28"))).map((w) => [w.title, w.label])).toContainEqual(["Maya Chen", "Approve or decline"]);
    await k.as("priya", (tx, c) => moveStep(tx, c, leave.id, "approved"), at("2026-07-29"));
    await k.as("rita", (tx, c) => createRow(tx, c, app.staff_leave!, "substitutions", { values: { section: ids.a6, date: "2026-08-03", period: "p2", absent: k.id.maya, substitute: k.id.omar, leave: leave.id } }), at("2026-07-29"));
    expect(await k.as("omar", (tx, c) => listRows(tx, c, app.staff_leave!, "leave"), at("2026-07-29"))).toEqual([]);
    expect((await k.as("omar", (tx, c) => listRows(tx, c, app.staff_leave!, "substitutions"), at("2026-07-29"))).map((r) => r.data.period)).toEqual(["p2"]);
  });

  it("the set's company rule is the company's", async () => {
    const rules = await k.as("ada", (tx, c) => companyRules(tx, c));
    expect(rules.rules.map((r) => r.text)).toEqual(["Every new student gets a fee card for the year."]);
  });
});
