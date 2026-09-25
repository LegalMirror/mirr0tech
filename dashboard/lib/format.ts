// Small presentational helpers. Pure functions, no deps.

/** Per-character animation delays for the wave wordmark. */
export function waveChars(word: string): { ch: string; delay: string }[] {
  return [...word].map((ch, i) => ({ ch, delay: `${i * 70}ms` }));
}

/** Short 0x1234…abcd form for addresses and hashes. */
export function short(hex: string, head = 6, tail = 4): string {
  if (!hex || hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function buildStamp(sha?: string, time?: string): string {
  const parts = [sha?.trim(), time?.trim()].filter((p): p is string => !!p);
  return parts.length ? `build ${parts.join(" · ")}` : "build unknown";
}

export const triLabel = (value: boolean | null | undefined) =>
  value === true ? "true" : value === false ? "false" : "unknown";

/** 1000000000000 micro-units → "1,000,000" */
export function fromMicro(units: string, decimals = 6): string {
  const value = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toLocaleString("en-US");
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}
