"use client";

import { Button } from "@/components/buttons";
import { MessageCard } from "@/components/auth/message-card";
import { linkClass } from "@/components/auth/controls";

// Something broke on a company's page: say so plainly, offer to try again, or to sign in again.
export default function WorkspaceError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <MessageCard title="Something went wrong" text="Please try again.">
      <Button kind="primary" className="w-full justify-center" onClick={() => retry()}>
        Try again
      </Button>
      <p className="m-0 text-center text-[15px]">
        <a href="/login" className={linkClass}>
          Sign in again
        </a>
      </p>
    </MessageCard>
  );
}
