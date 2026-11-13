"use client";

import { useEffect } from "react";

// Same-host moves after a server action are made by the browser, so the request goes through the
// host proxy. (Next's own redirect() would fetch the next page from the server's origin, which is
// the root host, not this workspace.)
export function useGo(next: string | undefined) {
  useEffect(() => {
    if (next) window.location.assign(next);
  }, [next]);
}
