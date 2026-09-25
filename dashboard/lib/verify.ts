// The front end checks the clause table against the hash committed on chain before rendering a quote
// (ARCHITECTURE §5), so a decoded revert cannot be pointed at a substituted sentence.
import type { ClauseEntry } from "./types";

/** Port of `canonical` from src/policy/document.js: sorted keys, no whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function clauseTableMatches(clauses: ClauseEntry[], committed: string): Promise<boolean> {
  return (await sha256Hex(canonical(clauses))) === committed.toLowerCase();
}
