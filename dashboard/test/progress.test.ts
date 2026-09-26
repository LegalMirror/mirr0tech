import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobProgress } from "@/app/_workbench/JobProgress";
import { AnalysisView } from "@/app/_workbench/AnalysisView";
import type { AgreementDetail } from "@/lib/agreements";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const at = "2026-09-26T20:00:00.000Z";

it("a job with a percent shows a spinner, a filled bar and the confidence so far", () => {
  const shown = html(createElement(JobProgress, { progress: { job: "j", percent: 42, confidence: 0.81, at } }));
  expect(shown).toContain("wb-spinner");
  expect(shown).toContain('aria-valuenow="42"');
  expect(shown).toContain("width:42%");
  expect(shown).toContain("42%");
  expect(shown).toContain("0.81");
});

it("a job without a percent yet shows a spinner and a moving bar, not a number", () => {
  const shown = html(createElement(JobProgress, { progress: null }));
  expect(shown).toContain("wb-spinner");
  expect(shown).toContain("wb-progress-indeterminate");
  expect(shown).not.toContain("aria-valuenow");
});

const record = (status: string, progress: AgreementDetail["progress"] = null) =>
  ({
    id: "agr_test",
    status,
    progress,
    history: [{ status: "uploaded", at }, { status: "extracting", at }],
    export: null,
    ast: null,
    extraction: null,
    error: null,
  }) as unknown as AgreementDetail;

it("the analysis view shows the progress while extracting instead of an awaiting label", () => {
  const view = (r: AgreementDetail) =>
    html(createElement(AnalysisView, { record: r, sample: false, onAst: () => {}, onIdentity: () => {} }));
  const running = view(record("extracting", { job: "j", percent: 30, confidence: null, at }));
  expect(running).toContain('role="progressbar"');
  expect(running).toContain("wb-spinner");
  expect(running).not.toContain("Awaiting analysis report");
  expect(view(record("extracting"))).toContain("wb-progress-indeterminate");
  expect(view(record("failed"))).not.toContain('role="progressbar"');
});
