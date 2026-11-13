"use client";

import { useLayoutEffect, type RefObject } from "react";

// A text box that grows with what is typed (0.3): its height follows the text up to maxRows lines, then it scrolls.
// For long text in forms and the chat message boxes.
export function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxRows: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const frame = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = line * maxRows + frame;
    el.style.height = "auto";
    const wanted = el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [ref, value, maxRows]);
}
