"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
const KEY = "mirrortech.theme";

// An explicit choice stamps data-theme (CSS wins on it); "system" clears it so the
// prefers-color-scheme media query decides. Also syncs <meta theme-color> to the resolved
// background so browser chrome matches.
export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode;
  else delete root.dataset.theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute("content", bg);
}

function readMode(): ThemeMode {
  // Storage throws on ACCESS when disabled, not merely when absent.
  let v = "";
  try {
    v = localStorage.getItem(KEY) || "";
  } catch {
    /* unreadable — follow the system */
  }
  return v === "light" || v === "dark" ? v : "system";
}

const OPTS: { mode: ThemeMode; glyph: string; label: string }[] = [
  { mode: "light", glyph: "☀", label: "Light" },
  { mode: "dark", glyph: "☾", label: "Dark" },
  { mode: "system", glyph: "◐", label: "System" },
];

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    const m = readMode();
    setMode(m);
    applyTheme(m);
  }, []);

  const choose = (m: ThemeMode) => {
    setMode(m);
    // Apply BEFORE persisting: a browser that refuses to store still honours the click.
    applyTheme(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* not remembered next visit */
    }
  };

  return (
    <div className="th-toggle" role="group" aria-label="Theme">
      {OPTS.map((o) => (
        <button
          key={o.mode}
          type="button"
          className={`th-opt ${mode === o.mode ? "th-on" : ""}`}
          aria-pressed={mode === o.mode}
          title={o.label}
          aria-label={o.label}
          onClick={() => choose(o.mode)}
        >
          <span aria-hidden>{o.glyph}</span>
        </button>
      ))}
    </div>
  );
}
