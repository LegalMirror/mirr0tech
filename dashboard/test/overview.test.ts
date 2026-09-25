import { describe, expect, it } from "vitest";
import { plainSummary } from "@/lib/labels";
import { proofLinks } from "@/lib/overview";
import type { AuditEvent } from "@/lib/types";

const event = (id: string, at: string, explorer: string | null): AuditEvent =>
  ({
    id,
    at,
    kind: "Fill",
    subject: "x",
    action: "transfer",
    summary: "",
    facts: {},
    txHash: explorer ? "0x1" : null,
    explorer,
    venue: "",
  }) as AuditEvent;

describe("proofLinks", () => {
  it("keeps only linked events, newest first, up to the limit", () => {
    const events = [
      event("a", "2026-01-01T00:00:00Z", "u1"),
      event("b", "2026-01-03T00:00:00Z", null),
      event("c", "2026-01-02T00:00:00Z", "u3"),
      event("d", "2026-01-04T00:00:00Z", "u4"),
    ];
    expect(proofLinks(events, 2).map((e) => e.id)).toEqual(["d", "c"]);
    expect(proofLinks(events).map((e) => e.id)).toEqual(["d", "c", "a"]);
  });
});

describe("plainSummary", () => {
  it("swaps identifiers for words and drops hashes", () => {
    expect(plainSummary("attested mlaCountersigned, notInsolvent")).toBe(
      "attested signed the loan agreement, not insolvent"
    );
    expect(plainSummary("shipped buyback 0x8582dad8…")).toBe("posted the buyback");
    expect(plainSummary("NoDepositCredential")).toBe("No deposit credential");
  });
});
