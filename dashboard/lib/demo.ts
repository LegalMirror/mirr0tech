import { BASE } from "./base";
import type { Upload } from "./agreements";

export const DEMO_FILES = [
  { name: "ea026411904ex10-9.htm", label: "BUIDL base contract", role: "source" },
  { name: "nav-cashier-addendum.md", label: "Separately authored NAV demo addendum", role: "source" },
  { name: "rwa-cashier-config.json", label: "Opt-in cashier compiler configuration", role: "config" },
] as const;
export const demoUrl = (name: string) => `${BASE}/demo/${name}`;
/** A two-page agreement a live Noolog reading finishes quickly; it has no fixture reading. */
export const SHORT_TEMPLATE = "short-fund-agreement.md";
export async function loadShortTemplate(signal?: AbortSignal): Promise<{ name: string; text: string }> {
  const response = await fetch(demoUrl(SHORT_TEMPLATE), { signal });
  if (!response.ok) throw new Error(`Could not load ${SHORT_TEMPLATE}. Run pnpm run demo:sync in dashboard and retry.`);
  return { name: SHORT_TEMPLATE, text: await response.text() };
}
export async function loadDemoBundle(signal?: AbortSignal): Promise<Upload> {
  const files = await Promise.all(
    DEMO_FILES.map(async (file) => {
      const response = await fetch(demoUrl(file.name), { signal });
      if (!response.ok)
        throw new Error(`Could not load ${file.name}. Run pnpm run demo:sync in dashboard and retry.`);
      return { ...file, text: await response.text() };
    })
  );
  return {
    name: "BUIDL · NAV demo",
    profile: "rwa-secondary",
    documents: files.filter((file) => file.role === "source").map(({ name, text }) => ({ name, text })),
    config: JSON.parse(files.find((file) => file.role === "config")!.text),
  };
}
