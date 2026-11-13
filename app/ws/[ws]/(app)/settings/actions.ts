"use server";

import { asAction } from "@/server/auth/kernel-call";
import { addAdmin, removeAdmin, updateSettings, type SettingsChange } from "@/server/kernel/settings";
import { saveUpload } from "@/server/kernel/uploads";
import { removeAiKey, setAiCap, setAiKey } from "@/server/kernel/instance-settings";

// Settings (9b): every change is a kernel call, which checks the person is an admin.

export async function renameCompany(name: string) {
  return asAction(async (tx, ctx) => updateSettings(tx, ctx, { name }));
}

// Website, address, currency, numbers, dates and the year (M26): one field at a time, as it's left or picked.
export async function changeSettings(change: Omit<SettingsChange, "logoUploadId">) {
  return asAction(async (tx, ctx) => updateSettings(tx, ctx, change));
}

export async function changeLogo(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "Pick an image.", problems: [] };
  const body = new Uint8Array(await file.arrayBuffer());
  return asAction(async (tx, ctx) => {
    const up = await saveUpload(tx, ctx, { name: file.name, body });
    return updateSettings(tx, ctx, { logoUploadId: up.id });
  });
}

export async function makeAdmin(personId: string) {
  return asAction(async (tx, ctx) => addAdmin(tx, ctx, personId));
}

export async function unmakeAdmin(personId: string) {
  return asAction(async (tx, ctx) => removeAdmin(tx, ctx, personId));
}

// Settings › AI (O3), the open Bike only: the kernel checks the person is an admin and the key with Anthropic.
export async function saveAiKey(key: string) {
  return asAction(async (tx, ctx) => (await setAiKey(tx, ctx, key), {}));
}

export async function deleteAiKey() {
  return asAction(async (tx, ctx) => (await removeAiKey(tx, ctx), {}));
}

export async function saveAiCap(usd: number | null) {
  return asAction(async (tx, ctx) => (await setAiCap(tx, ctx, usd), {}));
}
