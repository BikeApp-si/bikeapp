"use client";

import { useActionState } from "react";
import { ErrorText, Field, PrimaryButton, inputClass } from "./controls";
import { useGo } from "./use-go";

type State = { error: string | null; email: string; next?: string };

// 1a: work email, then a code.
export function LoginForm({ action }: { action: (prev: State, form: FormData) => Promise<State> }) {
  const [state, formAction, pending] = useActionState(action, { error: null, email: "" });
  useGo(state.next);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Work email">
        <input name="email" type="email" autoComplete="email" required autoFocus defaultValue={state.email} className={inputClass} />
      </Field>
      {state.error ? <ErrorText>{state.error}</ErrorText> : null}
      <PrimaryButton type="submit" disabled={pending || !!state.next}>Continue with email</PrimaryButton>
    </form>
  );
}
