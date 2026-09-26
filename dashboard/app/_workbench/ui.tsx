"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "../useBodyScrollLock";

export function Icon({
  name,
  size = 18,
}: {
  name:
    | "file"
    | "search"
    | "plus"
    | "tree"
    | "code"
    | "rocket"
    | "refresh"
    | "settings"
    | "arrow"
    | "close"
    | "menu"
    | "shield";
  size?: number;
}) {
  const paths = {
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5",
    search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    plus: "M12 5v14 M5 12h14",
    tree: "M12 3v6 M5 9h14 M5 9v6 M19 9v6 M9 3h6v3H9z M2 15h6v5H2z M16 15h6v5h-6z",
    code: "M8 5l-7 7 7 7 M16 5l7 7-7 7 M14 3l-4 18",
    rocket: "M14 4l6-1-1 6-9 9-5-5z M14 4l-6 1-5 6 5 1 M19 9l-1 7-5 5-1-5 M5 17l-2 4 4-2",
    refresh: "M20 7v5h-5 M4 17v-5h5 M5 7a8 8 0 0 1 14-1l1 6 M4 12l1 6a8 8 0 0 0 14-1",
    settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    close: "M6 6l12 12 M6 18L18 6",
    menu: "M4 6h16 M4 12h16 M4 18h16",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Brand() {
  return (
    <span className="wb-brand">
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <path
          d="M3 24V6l12 12L27 6v18M9 24V15l6 6 6-6v9"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Mirr0rtech<span className="wb-brand-dot">.</span>
      </span>
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useBodyScrollLock();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="wb-dialog"
      ref={ref}
      aria-labelledby="wb-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="wb-eyebrow">MIRR0RTECH WORKBENCH</span>
          <h2 id="wb-dialog-title">{title}</h2>
        </div>
        <button
          type="button"
          className="wb-icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`wb-notice ${error ? "wb-error" : ""}`} role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}
