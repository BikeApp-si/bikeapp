import { isRealDate } from "./values";

// The checks on a new person, shared by the Add a person form (as the admin types) and the kernel (when saved).

export type NewPerson = { name: string; email: string; title?: string | null; team?: string | null; managerId?: string | null; startDate?: string | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What's wrong with a new person, field by field (checked as the admin types, and again when saved).
export function checkNewPerson(p: NewPerson): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!p.name.trim()) errors.name = "Full name is needed.";
  else if (p.name.trim().length > 120) errors.name = "Full name is longer than 120 characters.";
  if (!p.email.trim()) errors.email = "Work email is needed.";
  else if (!EMAIL.test(p.email.trim())) errors.email = "That isn't an email address.";
  if (p.startDate && !isRealDate(p.startDate)) errors.startDate = "Start date must be a real date.";
  return errors;
}
