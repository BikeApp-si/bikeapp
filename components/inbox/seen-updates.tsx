"use client";

import { useEffect } from "react";
import { seenUpdates } from "@/app/ws/[ws]/(app)/inbox/actions";

// Once Updates are on screen, what they show is no longer new next time (the dots stay for this visit).
export function SeenUpdates() {
  useEffect(() => {
    void seenUpdates();
  }, []);
  return null;
}
