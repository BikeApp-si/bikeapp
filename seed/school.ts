// G3: Greenfield Public School, a CBSE school in Bengaluru that added the CBSE school set (gallery/cbse-school) on
// April 1, 2026, with its staff filling the set's slots by job title. A few rows for the flows: Class 6 and 7 with
// their sections and class teachers, the year's fee structures, students with their fee cards (made by the set's
// company rule), one payment, and an application that has been offered a seat. Rows live here, never in the set.
import path from "node:path";
import { eq } from "drizzle-orm";
import { people, workspaces } from "@/db/schema";
import type { KernelCtx } from "@/server/kernel/context";
import { addSet, suggestSlots } from "@/server/kernel/gallery/add";
import { loadSet } from "@/server/kernel/gallery/format";
import type { PersonInput } from "@/server/kernel/people";
import { createRow, listRows, moveStep } from "@/server/kernel/rows";
import { withWorkspace } from "@/server/kernel/tx";
import { seedWorkspace } from "./index";

const DOMAIN = "greenfield.test";
export const SCHOOL = { name: "Greenfield Public School", timeZone: "Asia/Kolkata" };
export const SCHOOL_ADMIN = { name: "Meera Krishnan", email: `meera@${DOMAIN}`, title: "Principal", team: "Leadership", startDate: "2019-06-01" };
const person = (name: string, user: string, title: string, team: string): PersonInput => ({ name, email: `${user}@${DOMAIN}`, title, team, managerEmail: SCHOOL_ADMIN.email, startDate: "2022-06-01" });
export const SCHOOL_PEOPLE: PersonInput[] = [
  person("Rahul Verma", "rahul", "Office administrator", "Office"),
  person("Sunita Rao", "sunita", "Accountant", "Office"),
  person("Kavya Menon", "kavya", "Teacher", "Teachers"),
  person("Arjun Pillai", "arjun", "Teacher", "Teachers"),
  person("Farah Khan", "farah", "Teacher", "Teachers"),
];

const at = (day: string, time = "10:00") => new Date(`${day}T${time}:00+05:30`);

export async function seedSchool(subdomain: string) {
  const ws = await seedWorkspace({ ...SCHOOL, subdomain }, SCHOOL_ADMIN, SCHOOL_PEOPLE, { created: "2026-03-20T09:00:00Z", imported: "2026-03-20T09:05:00Z" });
  if (!ws.created) return ws;
  const { workspaceId } = ws;
  await withWorkspace({ workspaceId }, async (tx) => {
    // M26: rupees, 12,34,567, "14 Nov 2026", a year from April.
    await tx.update(workspaces).set({ country: "IN", city: "Bengaluru", addressRegion: "KA", currency: "INR", holidayCountry: "IN", numberGrouping: "indian", dateStyle: "dmy", fiscalYearStart: 4 }).where(eq(workspaces.id, workspaceId));
    const all = await tx.select({ id: people.id, email: people.email, title: people.title }).from(people);
    const id = (user: string) => all.find((p) => p.email === `${user}@${DOMAIN}`)!.id;
    const as = (user: string, day: string, time?: string): KernelCtx => ({ workspaceId, actor: { id: id(user), email: `${user}@${DOMAIN}` }, now: at(day, time) });

    const set = loadSet(path.join(process.cwd(), "gallery/cbse-school"));
    const added = await addSet(tx, as("meera", "2026-04-01", "09:00"), set, { apps: set.apps, slots: suggestSlots(set, all) });
    const app = Object.fromEntries(added.apps.map((a) => [a.key, a.id]));

    // The office sets up the classes and sections.
    const office = as("rahul", "2026-04-01", "09:30");
    const add = async (values: Record<string, unknown>) => (await createRow(tx, office, app.students!, "classes", { values })).id;
    const class6 = await add({ name: "Class 6" });
    const class7 = await add({ name: "Class 7" });
    const a6 = await add({ name: "6 A", parent: class6, class_teacher: id("kavya"), room: "201" });
    const b6 = await add({ name: "6 B", parent: class6, class_teacher: id("arjun"), room: "202" });
    await add({ name: "7 A", parent: class7, class_teacher: id("farah"), room: "301" });

    // The accountant enters the year's fees: four instalments, due on the 10th of April, July, October and January.
    const dues = { due_1: "2026-04-10", due_2: "2026-07-10", due_3: "2026-10-10", due_4: "2027-01-10" };
    const accountant = as("sunita", "2026-04-01", "11:00");
    await createRow(tx, accountant, app.fees!, "structures", { values: { class: class6, from: "2026-04-01", tuition: 4_800_000, annual: 600_000, development: 0, activities: 0, ...dues } });
    await createRow(tx, accountant, app.fees!, "structures", { values: { class: class7, from: "2026-04-01", tuition: 5_100_000, annual: 600_000, development: 0, activities: 300_000, ...dues } });

    // Students in 6 A and 6 B; each gets a fee card from the set's company rule.
    const STUDENTS: [name: string, section: string, admission: string, roll: number, phone: string][] = [
      ["Riya Iyer", a6, "GPS/2024/0112", 1, "+91 98450 11111"],
      ["Ishaan Gupta", a6, "GPS/2024/0118", 2, "+91 98450 22222"],
      ["Kabir Rao", b6, "GPS/2024/0131", 1, "+91 98450 33333"],
    ];
    for (const [name, section, admission_no, roll_no, phone] of STUDENTS)
      await createRow(tx, as("rahul", "2026-04-02"), app.students!, "students", { values: { name, class: class6, section, admission_no, roll_no, dob: "2014-07-15", phone } });

    // Riya's family paid the first instalment.
    const cards = await listRows(tx, as("sunita", "2026-04-08"), app.fees!, "cards");
    const riya = (await listRows(tx, office, app.students!, "students")).find((s) => s.data.name === "Riya Iyer")!;
    const card = cards.find((c) => c.data.student === riya.id)!;
    await createRow(tx, as("sunita", "2026-04-08"), app.fees!, "payments", { values: { receipt_no: "R-2026-0001", card: card.id, amount: 1_350_000, mode: "upi", reference: "UPI 412233" } });

    // An application for Class 6, offered a seat.
    const application = await createRow(tx, as("rahul", "2026-10-12"), app.admissions!, "applications", {
      values: { child: "Aarav Sharma", class: class6, dob: "2014-05-11", gender: "boy", father: "Rohit Sharma", mother: "Neha Sharma", phone: "+91 98450 12345", last_school: "Little Flower School, Mysuru" },
    });
    await moveStep(tx, as("rahul", "2026-10-14"), application.id, "interaction");
    await moveStep(tx, as("rahul", "2026-10-20"), application.id, "offered");
  });
  return ws;
}
