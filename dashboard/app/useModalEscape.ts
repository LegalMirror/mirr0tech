"use client";

import { useEffect, useRef } from "react";

// Mount order is the truth: a modal opened later sits on top, so only the topmost answers Escape.
const stack: symbol[] = [];

export function useModalEscape(onEscape: () => void, enabled = true) {
  const cb = useRef(onEscape);
  cb.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("modal");
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (stack[stack.length - 1] !== id) return;
      cb.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}

/** Test seam */
export const __modalStackDepth = () => stack.length;
