import { SystemIcon } from "@/components/shell/system-icon";
import { connection } from "next/server";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { edition } from "@/edition";
import { SettingsForm } from "@/components/settings/settings-form";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { getSettings } from "@/server/kernel/settings";
import { peoplePicker } from "@/server/kernel/views";
import { countryChoices, currencyChoices } from "@/lib/places";

// 9b, admins only (the kernel refuses everyone else too).
export default async function SettingsPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  await requireAdmin(await currentWorkspace(wsParam));
  const { settings, people } = await asPage(wsParam, async (tx, ctx) => ({ settings: await getSettings(tx, ctx), people: await peoplePicker(tx) }));
  const tint = new Map(people.map((p) => [p.id, p.tint]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Settings" icon={<SystemIcon page="settings" />}>
        {edition.oneCompany() ? <SettingsTabs on="company" /> : null}
      </TopBar>
      <div className="flex-1 overflow-auto px-8 pt-2 pb-5">
        <SettingsForm
          name={settings.name}
          logoUploadId={settings.logoUploadId}
          details={settings}
          countries={countryChoices()}
          currencies={currencyChoices()}
          admins={settings.admins.map((a) => ({ ...a, tint: tint.get(a.id)! }))} people={people} />
      </div>
    </div>
  );
}
