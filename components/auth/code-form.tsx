"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Shield } from "lucide-react";
import { AuthHeading, AuthPage } from "./auth-page";
import { ErrorText, PrimaryButton, linkClass } from "./controls";
import { UNSENT } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { useGo } from "./use-go";

export type CodeState =
  | { status: "sent"; sentAt: number }
  | { status: "wrong"; triesLeft: number; sentAt: number }
  | { status: "expired"; sentAt: number }
  | { status: "limited"; retryInMinutes: number; sentAt: number }
  | { status: "unsent"; sentAt: number }
  | { status: "go"; next: string; sentAt: number };

// The form posts intent=verify with the code, or intent=resend.
export type CodeAction = (prev: CodeState, form: FormData) => Promise<CodeState>;

const LENGTH = 6;
const RESEND_SECONDS = 60;

function wrongText(triesLeft: number) {
  return `That code doesn’t match. ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left before we send a new one.`;
}

// 1c and 1d: six boxes, paste works, not case-sensitive. noRelay: the open Bike before it has a mail relay, where
// admins' codes go to Bike's log (docs/design/o2/b-code-no-relay.png).
export function CodeForm({ email, backHref, action, sentAt, logo, noRelay }: { email: string; backHref: string; action: CodeAction; sentAt: number; logo?: string | null; noRelay?: boolean }) {
  const [state, formAction, pending] = useActionState(action, { status: "sent", sentAt });
  useGo(state.status === "go" ? state.next : undefined);
  const wrong = state.status === "wrong" || state.status === "limited" || state.status === "expired" || state.status === "unsent";

  return (
    <AuthPage width={420}>
      <Link href={backHref} className="inline-flex items-center gap-1.5 self-start text-[15px] text-muted">
        <ChevronLeft size={14} strokeWidth={1.8} />
        Use a different email
      </Link>
      <AuthHeading title={noRelay ? "Find your code in the log" : "Check your email"} logo={logo}>
        {noRelay ? (
          <>This Bike has no mail relay yet, so admins’ codes go to Bike’s log, not email. It expires in 10 minutes.</>
        ) : wrong ? (
          <>Code sent to <b className="font-medium text-[#09090B]">{email}</b></>
        ) : (
          <>We sent a 6-character code to <b className="font-medium text-[#09090B]">{email}</b>. It expires in 10 minutes.</>
        )}
      </AuthHeading>

      <form action={formAction} className="flex flex-col gap-4">
        {/* A new code (sentAt changes) starts with empty boxes; a wrong one keeps what was typed. */}
        <CodeBoxes key={state.sentAt} wrong={wrong} pending={pending || state.status === "go"}>
          {state.status === "wrong" ? <ErrorText className="-mt-1">{wrongText(state.triesLeft)}</ErrorText> : null}
          {state.status === "expired" ? (
            <ErrorText className="-mt-1">
              That code has expired. <ResendButton>Send a new code</ResendButton>.
            </ErrorText>
          ) : null}
          {state.status === "unsent" ? <ErrorText className="-mt-1">{UNSENT}</ErrorText> : null}
          {state.status === "limited" ? (
            <ErrorText className="-mt-1">
              Too many codes. Try again in {state.retryInMinutes} {state.retryInMinutes === 1 ? "minute" : "minutes"}.
            </ErrorText>
          ) : null}
        </CodeBoxes>
        {state.status === "expired" ? null : (
          <p className="m-0 text-center text-[15px] text-muted">
            {wrong ? <ResendButton>Send a new code</ResendButton> : <Countdown key={state.sentAt} since={state.sentAt} />}
          </p>
        )}
      </form>

      {noRelay ? (
        <div className="rounded-[8px] border border-line bg-page px-3 py-2.5 text-[13.5px] leading-normal text-muted">
          On the server, run <code className="rounded-[4px] bg-fill px-1 font-mono text-[12.5px] text-ink">docker compose logs web | grep code</code>. Once
          your IT sets a mail relay, codes come by email.
        </div>
      ) : wrong ? null : (
        <div className="flex items-start gap-2.5 rounded-[8px] border border-line bg-page px-3 py-2.5 text-[13.5px] leading-normal text-muted">
          <Shield size={14} strokeWidth={1.8} className="mt-[3px] shrink-0" />
          <span>Letters and numbers, not case-sensitive. You can paste the whole code. Check spam for “Your Bike code”.</span>
        </div>
      )}
    </AuthPage>
  );
}

// The six boxes, sent as `code`. Verify under them, unless the form has its own button (first run: verify={false}).
export function CodeBoxes({ wrong, pending, children, verify = true }: { wrong: boolean; pending: boolean; children?: React.ReactNode; verify?: boolean }) {
  const [chars, setChars] = useState<string[]>(() => Array(LENGTH).fill(""));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const code = chars.join("");

  function fill(from: number, text: string) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!clean) return;
    const next = [...chars];
    for (let i = 0; i < clean.length && from + i < LENGTH; i++) next[from + i] = clean[i]!;
    setChars(next);
    boxes.current[Math.min(from + clean.length, LENGTH - 1)]?.focus();
  }

  return (
    <>
      <input type="hidden" name="code" value={code} />
      <div className="flex justify-center gap-2">
        {chars.map((c, i) => (
          <span key={i} className="contents">
            {i === 3 ? <span className="h-0.5 w-3 self-center bg-line" /> : null}
            <input
              ref={(el) => void (boxes.current[i] = el)}
              aria-label={`Character ${i + 1}`}
              value={c}
              inputMode="text"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              autoFocus={i === 0}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return setChars(chars.map((x, j) => (j === i ? "" : x)));
                fill(i, c && v.length > 1 ? v.replace(c, "") : v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !c && i > 0) boxes.current[i - 1]?.focus();
              }}
              onPaste={(e) => {
                e.preventDefault();
                fill(0, e.clipboardData.getData("text"));
              }}
              className={cn(
                "h-[52px] w-11 rounded-[6px] border bg-white text-center text-[28px] font-medium text-[#09090B] uppercase shadow-[0_1px_2px_rgba(0,0,0,.05)] outline-none",
                wrong ? "border-danger" : "border-line focus:border-primary focus:shadow-[0_0_0_3px_#DCEEFF]",
              )}
            />
          </span>
        ))}
      </div>
      {children}
      {verify ? (
        <PrimaryButton type="submit" name="intent" value="verify" disabled={code.length < LENGTH || pending}>
          Verify
        </PrimaryButton>
      ) : null}
    </>
  );
}

function ResendButton({ children }: { children: React.ReactNode }) {
  return (
    <button type="submit" name="intent" value="resend" formNoValidate className={cn(linkClass, "cursor-pointer")}>
      {children}
    </button>
  );
}

function Countdown({ since }: { since: number }) {
  const [left, setLeft] = useState(RESEND_SECONDS);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, RESEND_SECONDS - Math.floor((Date.now() - since) / 1000)));
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [since]);
  if (left > 0) return <>Didn’t get it? Resend in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</>;
  return <>Didn’t get it? <ResendButton>Resend</ResendButton></>;
}
