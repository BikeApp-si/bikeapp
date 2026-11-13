"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { usePathname } from "next/navigation";
import { PageLoading } from "./page-loading";

// A click in the sidebar shows the loading screen in the panel at once, in place of the page being left,
// until the new page's address arrives. Only the browser changes; the server answers as before (a refused page
// is still a 404, and no form loses what was typed).

const Start = createContext<(href: string) => void>(() => {});
const Leaving = createContext<string | null>(null);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [leaving, setLeaving] = useState<string | null>(null);
  // A new address ends the wait (adjusted while rendering, as React suggests for state that follows a prop).
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    setSeen(path);
    setLeaving(null);
  }
  // Only a new path shows it: a link to another sheet of the same page (?sheet=…) changes no path, and would wait forever.
  const start = useCallback((href: string) => setLeaving(href.split("?")[0] === path ? null : path), [path]);
  return (
    <Start.Provider value={start}>
      <Leaving.Provider value={leaving}>{children}</Leaving.Provider>
    </Start.Provider>
  );
}

export const useStartNavigation = () => useContext(Start);

// The panel: the loading screen while a page is on its way, in front of the page being left, which stays
// mounted but hidden (unmounting it would also drop Next's own router state for that page).
export function NavigationPanel({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const waiting = useContext(Leaving) === path;
  return (
    <>
      <div className={waiting ? "hidden" : "contents"}>{children}</div>
      {waiting ? <PageLoading /> : null}
    </>
  );
}
