"use client";

import { useEffect } from "react";

// Counted, not per-overlay: two overlays open at once must not let the first one to close unlock
// the page behind the second. The original inline style is captured once and restored.
let holders = 0;
let saved: string | null = null;

export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    if (holders === 0) {
      saved = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    holders += 1;
    return () => {
      holders -= 1;
      if (holders === 0) {
        document.body.style.overflow = saved ?? "";
        saved = null;
      }
    };
  }, [active]);
}

/** Test seam: assert the count drains rather than inferring it from the style. */
export const __scrollLockHolders = () => holders;
