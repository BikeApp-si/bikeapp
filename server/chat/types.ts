import type { MoveView } from "./move-view";
import type { DesignOutput } from "@/server/ai/prompts/capability-designer@11";
import type { DraftRule } from "@/server/kernel/plans/draft";
import type { CheckedFile } from "@/server/kernel/plans/import-check";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { CompanyRule } from "@/server/kernel/schema/company";

// A plan as stored in the chat (plans.draft): what the designer and logic writer wrote, the new capability's
// id (kept across versions), and what the kernel worked out for it. The files themselves are compiled again
// from this on Create, so what is applied is checked against the workspace as it is then.
export type PlanDraft = {
  newId: string;
  design: DesignOutput;
  rules: DraftRule[];
  couldNot: { sentence: string; reason: string }[];
  summary: string; // "1 sheet, 5 steps, 2 rules, 2 roles"
  preview: string; // the 90-day line (5j)
  import?: ImportDraft | null; // a file to import on Create (5g)
};

// A CSV waiting to be imported when the capability is created, as the kernel checked it (5g).
export type ImportDraft = CheckedFile;

// A Customize preview as stored in its chat (6c, 6f, 6h, 6k): the change set the kernel checked, and what
// the reply shows. Apply checks every file again against the workspace as it is then.
export type CustomizeDraft = {
  kind: "customize";
  capabilityId: string;
  capability: string;
  version: number; // the version it previews
  edits: [string, { before: CapabilityFile; after: CapabilityFile; changes: string[] }][];
  reply: string; // prompt 3's first line
  title?: string | null; // prompt 3's few words ("Legal review step"); on Apply the chat is named by it (12b)
  changes: { explain: string; where: string; part: string }[];
  // A step renamed with its rows (6h): what reads it, now under the new name.
  renames: { from: string; to: string; count: number; rows: { one: string; many: string }; insteadOfRemoval: boolean; uses: { kind: "connection" | "rule" | "total"; text: string }[] }[];
  impact: string; // the kernel's sentence about today's rows
  // A single new rule (6f): how Bike reads it, and what it would have done on the last 90 days.
  rule: {
    when: string;
    then: string;
    daily: boolean;
    rows: { one: string; many: string };
    preview: { columns: string[]; rows: string[][] };
    // M32: a repeating rule (m32-a): the next date, the row it adds, and the dates it would have added.
    repeats?: { next: string | null; columns: string[]; values: { text: string; person?: boolean }[]; past: number; pastWords: string };
  } | null;
  button: string; // "Apply 3 changes", "Apply with these fixes", "Apply", "Add this rule", "Apply and link 12 contracts"
  collapsed: { lead: string; tail: string }; // "Here's what changes" … "3 changes"
  // M27: what each data move does to today's rows (m27-a), or the rows it can't map, with no Apply (m27-b).
  moves?: MoveView[];
  moveParts?: string[]; // their lines in Apply's Part / Status list: "Link 12 contracts to Customers"
};

// A company rule's preview as stored in its chat (0.2): the company's rules as Apply would save them, and what the
// reply shows. Apply checks them again, and refuses when the company's rules changed since the preview.
export type CompanyDraft = {
  kind: "company";
  version: number; // the company-rules version it previews
  rules: CompanyRule[]; // the whole list as it would be saved
  ruleId: string | null; // the rule written or changed; null for a removal
  change: "add" | "change" | "remove";
  text: string; // the rule's sentence
  reply: string;
  when: string | null;
  then: string | null;
  appliesTo: { where: string; when: string }[]; // "Spend · Expenses" / "An expense over $10,000 is added"
  preview: { rows: { title: string; where: string; on: string }[] }; // the last 90 days, every part together
  warnings: string[];
  button: string; // "Apply", "Remove this rule"
  collapsed: { lead: string; tail: string };
};
