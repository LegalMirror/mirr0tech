"use client";

import Link from "next/link";
import { BASE } from "@/lib/base";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import build from "@/lib/build-info.json";
import { source } from "@/lib/adapter";
import { buildStamp, waveChars } from "@/lib/format";
import type { ProfileId } from "@/lib/types";
import { ProfileSwitch } from "./ProfileSwitch";
import { ThemeToggle } from "./ThemeToggle";
import { useProfile } from "./providers";
import { useBodyScrollLock } from "./useBodyScrollLock";
import { useModalEscape } from "./useModalEscape";

function nav(profile: ProfileId) {
  return [
    { href: "/", label: "Policy", hint: "clause → contract" },
    {
      href: "/lenders",
      label: profile === "wildcat-credit" ? "Lenders" : "Investors",
      hint: "status & facts",
    },
    { href: "/queue", label: "Queue", hint: "review items" },
    { href: "/exit", label: profile === "wildcat-credit" ? "Exit" : "Trade", hint: "venue" },
    { href: "/audit", label: "Audit", hint: "timeline" },
  ];
}

/** A nav entry is active on its own route and its sub-routes; "/" only on itself. */
export function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

function Wordmark() {
  return (
    <span className="wordmark wave">
      {waveChars("mirr0tech").map((c, i) => (
        <span key={i} style={{ animationDelay: c.delay }}>
          {c.ch}
        </span>
      ))}
    </span>
  );
}

/**
 * The kjuis shell: a left sidebar on a wide screen, the same markup as a full-screen drawer on a
 * narrow one. While the drawer is open the page behind it leaves the tab order and the a11y tree.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { profile } = useProfile();
  const [navOpen, setNavOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevOpen = useRef(false);

  useEffect(() => setNavOpen(false), [path]);
  useBodyScrollLock(navOpen);
  useModalEscape(() => setNavOpen(false), navOpen);
  useEffect(() => {
    if (navOpen) closeRef.current?.focus();
    else if (prevOpen.current) burgerRef.current?.focus();
    prevOpen.current = navOpen;
  }, [navOpen]);

  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const close = () => setNavOpen(false);

  return (
    <div className="sh-root">
      <header className="sh-mobtop" inert={compact && navOpen ? true : undefined}>
        <button
          ref={burgerRef}
          className="sh-burger"
          aria-label="Menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          ☰
        </button>
        <Link href="/" className="sh-brand" onClick={close} aria-label="mirr0tech home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/mark.svg`} alt="" aria-hidden className="sh-logo" width={22} height={22} />
          <Wordmark />
        </Link>
        {compact && <ThemeToggle />}
      </header>

      <aside
        className={`sh-side ${navOpen ? "sh-sideOpen" : ""}`}
        inert={compact && !navOpen ? true : undefined}
        role={compact && navOpen ? "dialog" : undefined}
        aria-modal={compact && navOpen ? true : undefined}
        aria-label={compact && navOpen ? "Menu" : undefined}
      >
        <button ref={closeRef} className="sh-close" aria-label="Close menu" onClick={close}>
          ✕
        </button>
        <Link href="/" className="sh-brand sh-brandSide" onClick={close} aria-label="mirr0tech home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/mark.svg`} alt="" aria-hidden className="sh-logo" width={26} height={26} />
          <Wordmark />
        </Link>
        <ProfileSwitch />
        <nav className="sh-nav" aria-label="Primary">
          {nav(profile).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={close}
              className={`sh-navLink ${isActive(path, n.href) ? "sh-on" : ""}`}
            >
              <span>{n.label}</span>
              <small className="sh-navHint">{n.hint}</small>
            </Link>
          ))}
        </nav>
        <div className="sh-sideFoot">
          {!compact && <ThemeToggle />}
          <p className="sh-note muted">
            {buildStamp(build.sha, build.builtAt)} ·{" "}
            {source.kind === "static" ? "static export · snapshot or mock parties" : "live gateway"}
          </p>
        </div>
      </aside>

      <main className="sh-body" inert={compact && navOpen ? true : undefined}>
        {children}
      </main>
    </div>
  );
}
