"use client";

import { useActionState, useSyncExternalStore } from "react";
import { AuthHeading, AuthPage } from "./auth-page";
import { CodeBoxes } from "./code-form";
import { ErrorText, Field, PrimaryButton, inputClass } from "./controls";
import { useGo } from "./use-go";
import { timeZoneOptions } from "@/lib/timezones";
import type { FirstRunState } from "@/app/first-run/actions";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The open Bike's first run (docs/design/o2/a-first-run.png, a2): the setup code from the log, the company and its
// first admin.
export function FirstRunForm({ host, action }: { host: string; action: (prev: FirstRunState, form: FormData) => Promise<FirstRunState> }) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  useGo(state.next);
  const zone = useSyncExternalStore(() => () => {}, browserZone, () => null);
  const v = state.values ?? {};

  return (
    <AuthPage width={420}>
      <AuthHeading title="Set up your Bike">
        This Bike is at <b className="font-medium text-[#09090B]">{host}</b>. You’ll be its first admin.
      </AuthHeading>
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[15px] text-muted">Setup code</span>
          <CodeBoxes wrong={!!state.codeWrong} pending={pending} verify={false}>
            {state.codeWrong ? (
              <ErrorText className="-mt-1">{state.error}</ErrorText>
            ) : (
              <p className="-mt-1 mb-0 text-center text-[13.5px] text-muted">
                It’s in Bike’s log: <code className="rounded-[4px] bg-fill px-1 font-mono text-[12.5px] text-ink">docker compose logs web</code>
              </p>
            )}
          </CodeBoxes>
        </div>
        <Field label="Company name">
          <input name="company" defaultValue={v.company} className={inputClass} autoComplete="organization" />
        </Field>
        <Field label="Your name">
          <input name="name" defaultValue={v.name} className={inputClass} autoComplete="name" />
        </Field>
        <Field label="Work email">
          <input name="email" type="email" defaultValue={v.email} className={inputClass} autoComplete="email" />
        </Field>
        <Field label="Time zone">
          <select key={zone ?? ""} name="timeZone" defaultValue={v.timeZone || undefined} className={inputClass}>
            {timeZoneOptions(zone).map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Anthropic key (optional)" hint="To build and change apps from words. You can add it later in Settings › AI.">
          <input name="aiKey" defaultValue={v.aiKey} className={`${inputClass} font-mono`} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} />
        </Field>
        {state.error && !state.codeWrong ? <ErrorText>{state.error}</ErrorText> : null}
        <PrimaryButton type="submit" disabled={pending || !!state.next}>
          Create company
        </PrimaryButton>
      </form>
    </AuthPage>
  );
}
