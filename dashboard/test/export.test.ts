import { describe, expect, it } from "vitest";
import { AbiCoder } from "ethers";
import { canonical, clauseTableMatches, sha256Hex } from "@/lib/verify";
// Plain ESM from the repository root; types are inferred from the JavaScript.
import { anchorFor, annotateProgram, displayOf } from "../../scripts/export-ui.js";
import { compiled } from "./fixtures";

const PROFILES = ["custodial-rwa", "rwa-secondary", "wildcat-credit"] as const;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

describe("displayOf", () => {
  it("keeps line structure while mapping every normalized character to where it is shown", () => {
    const source = "  # Title\n\n\n1.1   First   line\nsecond\t line  ";
    const { display, text, map } = displayOf(source);
    expect(text).toBe(collapse(source));
    expect(display).toBe("# Title\n\n1.1 First line\nsecond line");
    for (let index = 0; index < text.length; index++) {
      const shown = display[map[index]];
      expect(text[index] === " " ? /\s/.test(shown) : shown === text[index]).toBe(true);
    }
    expect(map[text.length]).toBe(display.length);
  });
});

describe.each(PROFILES)("%s export", (profile) => {
  it("locates every quote at its normalized and display offsets", async () => {
    const policy = await compiled(profile);
    for (const item of [...policy.rules, ...policy.terms]) {
      expect(item.quotes.length).toBeGreaterThan(0);
      for (const at of item.quotes) {
        expect(policy.text.slice(at.start, at.end)).toBe(item.source.quote);
        const shown = policy.documents[at.part].display.slice(at.displayStart, at.displayEnd);
        expect(collapse(shown)).toBe(item.source.quote);
      }
    }
  });

  it("reassembles the bundled text from its parts", async () => {
    const policy = await compiled(profile);
    const joined = policy.documents.map((part) => collapse(part.display)).join(" ");
    expect(joined).toBe(policy.text);
    for (const part of policy.documents)
      expect(policy.text.slice(part.start, part.end)).toBe(collapse(part.display));
  });

  it("exports DNF bit lists that agree with their masks", async () => {
    const policy = await compiled(profile);
    for (const rule of policy.rules)
      for (const term of rule.dnf) {
        const mask = (bits: number[]) =>
          `0x${bits.reduce((acc, bit) => acc | (1n << BigInt(bit)), 0n).toString(16)}`;
        expect(mask(term.pos)).toBe(term.posMask);
        expect(mask(term.neg)).toBe(term.negMask);
      }
  });

  it("labels program words that decode to the same rules the ABI decoder sees", async () => {
    const policy = await compiled(profile);
    for (const program of policy.programs) {
      const [decoded] = AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 effect,uint16 clauseId,uint256[] pos,uint256[] neg)[]"],
        program.hex
      );
      expect(program.rules.map((rule) => rule.clauseId)).toEqual(
        decoded.map((rule: { clauseId: bigint }) => Number(rule.clauseId))
      );
      for (const [index, rule] of program.rules.entries()) {
        expect(rule.byteEnd).toBeGreaterThan(rule.byteStart);
        const pos = rule.words
          .filter((word) => word.label.startsWith("pos["))
          .map((word) => BigInt(word.hex));
        expect(pos).toEqual([...decoded[index].pos]);
        const owner = policy.rules.find((entry) => entry.clauseId === rule.clauseId)!;
        expect(owner.action).toBe(program.action);
        expect(rule.ruleId).toBe(owner.id);
      }
      expect(program.byteLength).toBe((program.hex.length - 2) / 2);
    }
  });

  it("commits a clause table the browser hash check accepts, and rejects a substituted quote", async () => {
    const policy = await compiled(profile);
    expect(await clauseTableMatches(policy.clauseTable, policy.clauseTableHash)).toBe(true);
    const tampered = policy.clauseTable.map((entry, index) =>
      index === 0 ? { ...entry, quote: `${entry.quote}.` } : entry
    );
    expect(await clauseTableMatches(tampered, policy.clauseTableHash)).toBe(false);
  });
});

describe("annotateProgram", () => {
  it("labels the header of an empty program", () => {
    const empty = AbiCoder.defaultAbiCoder().encode(["tuple(uint8,uint16,uint256[],uint256[])[]"], [[]]);
    const annotated = annotateProgram(empty, []);
    expect(annotated.rules).toEqual([]);
    expect(annotated.header.map((word: { label: string }) => word.label)).toEqual([
      "offset of the rule array",
      "rule count = 0",
    ]);
  });
});

describe("anchorFor", () => {
  const parts = [
    { name: "wildcat-mla.md", display: "# MLA\n### 4) Default\ntext\n## EXHIBIT A\nterms" },
    { name: "lender-check-policy.md", display: "## 2. Checks\n2.2 Due diligence.\n2.3 AML." },
  ];
  it("anchors MLA sections, policy paragraphs and exhibits to the start of their line", () => {
    expect(anchorFor("MLA 4), 5)", parts)).toEqual({ part: 0, offset: 6 });
    expect(anchorFor("Lender Check Policy 2.3", parts)).toEqual({ part: 1, offset: 32 });
    expect(anchorFor("Exhibit A", parts)).toEqual({ part: 0, offset: 26 });
    expect(anchorFor("Preamble; 2.1", parts)).toEqual({ part: 0, offset: 0 });
  });
  it("leaves a reference it cannot place unanchored", () => {
    expect(anchorFor("Agreement generally", parts)).toBeNull();
    expect(anchorFor("MLA 9)", parts)).toBeNull();
  });
});

describe("verification export", () => {
  it("carries the deliberation's verdicts and a confidence per rule", async () => {
    const policy = await compiled("wildcat-credit");
    const v = policy.verification!;
    expect(v.provider).toBe("noolog");
    expect(v.mock).toBe(true);
    expect(v.agents).toEqual(["extractor", "critic"]);
    expect(v.confidence.overall).toBeGreaterThan(0.5);
    expect(v.confidence.overall).toBeLessThanOrEqual(1);
    for (const rule of policy.rules) expect(v.confidence.byRef[`rule:${rule.id}`]).toBe(1);
    expect(v.claims.every((c) => c.verdicts.length > 0)).toBe(true);
  });
});

describe("buyback export", () => {
  it("decodes the strategy into instructions that carry the policy hash and the addendum terms", async () => {
    const policy = await compiled("wildcat-credit");
    const buyback = policy.buyback;
    expect(buyback).not.toBeNull();
    if (!buyback?.available) return; // vendor/swap-vm not fetched: nothing to decode
    expect(buyback.instructions.map((ins) => ins.name)).toEqual([
      "Controls._deadline",
      "PolicyGuard._policyGuard",
      "FixedRateBalances._fixedRateBalances",
      "LimitSwap._limitSwap1D",
      "Invalidators._invalidateTokenIn1D",
    ]);
    expect(buyback.program).toContain(policy.policyHash.slice(2));
    expect(`0x${buyback.instructions.map((ins) => ins.bytes.slice(2)).join("")}`).toBe(buyback.program);
    expect(buyback.terms).toMatchObject({ price: "0.96", cap: "1000000", deadline: "2026-12-31" });
    expect(buyback.strategyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buyback.auction).not.toBeNull();
    expect(buyback.auction!.instructions.map((ins) => ins.name)[3]).toBe(
      "DutchAuction._dutchAuctionBalanceOut1D"
    );
    expect(buyback.auction).toMatchObject({ ceiling: "1.00", windowHours: "6" });
    expect(`0x${buyback.auction!.instructions.map((ins) => ins.bytes.slice(2)).join("")}`).toBe(
      buyback.auction!.program
    );
  });
});

describe("canonical", () => {
  it("sorts keys at every depth so the hash does not depend on field order", async () => {
    expect(canonical({ b: 1, a: [{ d: "x", c: null }] })).toBe('{"a":[{"c":null,"d":"x"}],"b":1}');
    expect(await sha256Hex("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
