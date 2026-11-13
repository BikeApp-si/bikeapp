"use server";

import { z } from "zod";
import { asAction } from "@/server/auth/kernel-call";
import { addFromGallery } from "@/server/gallery/add";
import { listedSet } from "@/server/gallery/list";
import { previewSet } from "@/server/kernel/gallery/add";
import { KernelError } from "@/server/kernel/context";

// G2: the add flow's plan and Add. The set is read from the gallery by its name, never sent by the browser; the
// kernel checks the admin, the apps and the people.

const choiceSchema = z.strictObject({
  apps: z.array(z.string().max(40)).max(40),
  slots: z.record(z.string().max(40), z.array(z.string().uuid()).max(200)),
});

function setFor(key: string) {
  const set = listedSet(key);
  if (!set) throw new KernelError("That app set isn't in the gallery.");
  return set;
}

function choiceOf(raw: unknown) {
  const parsed = choiceSchema.safeParse(raw);
  if (!parsed.success) throw new KernelError("That choice of apps and people can't be read.");
  return parsed.data;
}

export async function previewGallerySet(setKey: string, choice: unknown) {
  return asAction(async (tx, ctx) => ({ preview: await previewSet(tx, ctx, setFor(setKey), choiceOf(choice)) }));
}

export async function addGallerySet(setKey: string, choice: unknown) {
  return asAction(async (tx, ctx) => ({ added: await addFromGallery(tx, ctx, setFor(setKey), choiceOf(choice)) }));
}
