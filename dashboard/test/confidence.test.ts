import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import live from "./fixtures-live-verification.json";
import { confidenceBasis, verdictsOf } from "@/lib/confidence";
import { ConfidenceSummary } from "@/app/_workbench/ConfidenceSummary";
import type { Verification } from "@/lib/types";

const report = live as unknown as Verification;
const text = (verification: Verification) =>
  renderToStaticMarkup(createElement(ConfidenceSummary, { report: verification })).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

it("a live report scored as a whole shows the confidence, its basis and each model's score", () => {
  expect(report.claims).toHaveLength(0);
  const shown = text(report);
  expect(shown).toContain("Confidence 1.00");
  expect(shown).toContain("from 2 models' scores of the final answer; they did not split it into separate claims");
  expect(shown).toContain("live deliberation");
  expect(shown).toContain("RwaCounsel scored the answer 1.00");
  expect(shown).toContain("no justification given");
});

it("a report with checked claims says how many, and a claim without verdicts says so", () => {
  const withClaims: Verification = {
    ...report,
    mock: true,
    evaluations: [],
    claims: [{ key: "49beba", ref: "49beba", claim: "Shares issue on receipt of funds", verdicts: [], disputed: true, score: 0 }],
    confidence: { ...report.confidence, overall: 0.62, basis: "claims", total: 1 },
  };
  expect(confidenceBasis(withClaims)).toBe("from 1 claim the models checked");
  expect(text(withClaims)).toContain("Confidence 0.62");
  expect(text(withClaims)).toContain("mock, not independent model judgment");
  expect(verdictsOf(withClaims.claims[0])).toBe("No verdict recorded for this claim.");
  expect(confidenceBasis({ ...withClaims, confidence: { ...withClaims.confidence, basis: "winner" } })).toBe("from the winning answer's aggregate score");
});
