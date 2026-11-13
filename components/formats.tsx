"use client";

import { createContext, useContext } from "react";
import { US, type Formats } from "@/lib/format";

// How the company writes money, numbers and dates (M26), for every value drawn in the browser. Set once by the
// signed-in frame from Settings; pages outside it read dollars.
const FormatsContext = createContext<Formats>(US);

export function FormatsProvider({ formats, children }: { formats: Formats; children: React.ReactNode }) {
  return <FormatsContext.Provider value={formats}>{children}</FormatsContext.Provider>;
}

export const useFormats = () => useContext(FormatsContext);
