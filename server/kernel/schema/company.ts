import { z } from "zod";
import { ruleSchema } from "./file";

// A company rule (0.2): one policy in plain words for the whole company ("orders and contracts over $10,000 need
// Lena's approval"), applied to one or more capabilities' sheets. Each application is an ordinary rule on its
// capability (trigger, condition, actions), with an id of its own, unique within the company rule; the kernel
// runs it like that capability's own rules (rule-set.ts). Saved as one versioned list (company_rules).

const id = z.string().regex(/^[a-z0-9_]{1,40}$/, "Ids are lowercase letters, digits and _");

export const applicationSchema = z.strictObject({
  id,
  capabilityId: z.uuid(),
  ...ruleSchema.pick({ trigger: true, condition: true, actions: true }).shape,
});

export const companyRuleSchema = z
  .strictObject({
    id,
    text: z.string().min(1),
    reading: z.strictObject({ when: z.string().min(1), then: z.string().min(1) }),
    enabled: z.boolean(),
    applications: z.array(applicationSchema).min(1),
  })
  .refine((r) => new Set(r.applications.map((a) => a.id)).size === r.applications.length, { message: "Each part of a company rule needs its own id." });

export const companyRulesSchema = z.array(companyRuleSchema).refine((rs) => new Set(rs.map((r) => r.id)).size === rs.length, { message: "Each company rule needs its own id." });

export type Application = z.infer<typeof applicationSchema>;
export type CompanyRule = z.infer<typeof companyRuleSchema>;
