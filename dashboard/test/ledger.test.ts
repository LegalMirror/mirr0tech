import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import live from "./fixtures-live-ledger.json";
import { fetchLedger, shares, type Ledger } from "@/lib/ledger";
import { Boundaries, Decisions, Supply } from "@/app/ledger/LedgerCards";
import { BoundaryDiagram, ClauseBars, DecisionTimeline } from "@/app/ledger/LedgerVisuals";

const ledger = live as unknown as Ledger;
const text = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

afterEach(() => vi.unstubAllGlobals());

it("shares reads the token's six decimals", () => {
  expect(shares("8500000000")).toBe("8,500");
  expect(shares("1234567")).toBe("1.23");
  expect(shares("")).toBe("0");
});

it("the hook card shows the gated callbacks, the pool and every clause deciding a transfer, quoted", () => {
  const shown = text(createElement(Boundaries, { ledger }));
  for (const callback of ["Add liquidity", "Remove liquidity", "Swap"]) expect(shown).toContain(callback);
  expect(shown).toContain("fee 0.3%");
  expect(shown).toContain("tick spacing 60");
  expect(shown).not.toContain("Every one of these asks the agreement first");
  for (const clause of ledger.boundaries.transferClauses) {
    expect(shown).toContain(`§${clause.clauseId} ${clause.effect}`);
    expect(shown).toContain(clause.quote!.slice(0, 40));
  }
  expect(renderToStaticMarkup(createElement(Boundaries, { ledger }))).toContain(`https://sepolia.etherscan.io/address/${ledger.boundaries.hook}`);
});

it("the decisions card lists each indexed decision with an explorer link and the tally by clause", () => {
  expect(ledger.decisions.length).toBeGreaterThanOrEqual(3);
  const html = renderToStaticMarkup(createElement(Decisions, { ledger }));
  const shown = text(createElement(Decisions, { ledger }));
  expect(shown).not.toContain("admitted: ");
  for (const decision of ledger.decisions.filter((d) => d.tx)) expect(html).toContain(`https://sepolia.etherscan.io/tx/${decision.tx}`);
  expect(shown).not.toContain("A refused swap reverts before a transaction exists");
  expect(shown).toContain("no transaction · gateway audit");
  expect(shown).toContain("refused · transfer-identity-verified");
});

it("a refused decision names its rule, and an empty ledger says indexing starts at the link", () => {
  const refused: Ledger = {
    ...ledger,
    decisions: [{ ...ledger.decisions[0], allowed: false, clauseId: 12, clause: ledger.boundaries.transferClauses.find((c) => c.clauseId === 12) ?? null }],
  };
  expect(text(createElement(Decisions, { ledger: refused }))).toContain("refused · transfer-identity-verified");
  expect(text(createElement(Decisions, { ledger: { ...ledger, decisions: [], byClause: [] } }))).toContain("No hook decisions indexed yet");
});

it("the supply card shows minted and redeemed shares and the attestations with their expiry", () => {
  const shown = text(createElement(Supply, { ledger }));
  expect(shown).toContain("8,500 shares minted");
  expect(shown).not.toContain("summed by the MultiBaas query language");
  expect(shown).toContain(`valid until ${new Date(ledger.attestations[0].expiresAt * 1000).toISOString().slice(0, 10)}`);
});

it("fetchLedger reads the gateway's public route and explains a gateway without MultiBaas", async () => {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(ledger), { status: 200 });
  }));
  expect((await fetchLedger()).agreement).toBe(ledger.agreement);
  expect(seen[0]).toMatch(/\/v1\/indexed\/ledger$/);
  // No ledger on the gateway: the committed snapshot answers, marked as such.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/ledger.json") ? new Response(JSON.stringify(ledger)) : new Response("{}", { status: 404 }))));
  expect((await fetchLedger()).snapshot).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  await expect(fetchLedger()).rejects.toThrow("no MultiBaas ledger configured");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
  await expect(fetchLedger()).rejects.toThrow("Ledger unavailable (502)");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
  await expect(fetchLedger()).rejects.toThrow("The gateway did not answer.");
});

it("the boundary diagram counts admitted and refused attempts and marks the clause that refused", () => {
  const admitted = ledger.decisions.filter((d) => d.allowed).length;
  const refused = ledger.decisions.filter((d) => !d.allowed).length;
  expect(refused).toBeGreaterThan(0);
  const html = renderToStaticMarkup(createElement(BoundaryDiagram, { ledger }));
  expect(html).toContain(`aria-label="Hook boundary: ${admitted} admitted, ${refused} refused"`);
  const shown = text(createElement(BoundaryDiagram, { ledger }));
  expect(shown).toContain(`${admitted} admitted`);
  expect(shown).toContain("gated · swap");
  expect(shown).toContain("§12 identity-verified");
  expect(shown).toContain(`${refused} refused`);
});

it("the clause bars and the timeline plot every decision, refusals in their own lane", () => {
  const bars = text(createElement(ClauseBars, { ledger }));
  expect(bars).toContain("admitted (no clause refused)");
  expect(bars).toContain("transfer-identity-verified");
  const timeline = renderToStaticMarkup(createElement(DecisionTimeline, { ledger }));
  expect((timeline.match(/<circle/g) ?? []).length).toBe(ledger.decisions.length);
  expect(timeline).toContain("refused · transfer-identity-verified");
  expect(renderToStaticMarkup(createElement(DecisionTimeline, { ledger: { ...ledger, decisions: [] } }))).toBe("");
});
