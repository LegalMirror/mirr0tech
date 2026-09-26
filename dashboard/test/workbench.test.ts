import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dnfText,
  graphForAction,
  layoutGraph,
  nodeTone,
  sampleGraph,
  verificationLabel,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "@/lib/workbench";
import { Evidence, GraphPane, SourceCards } from "@/app/_workbench/PolicyPanes";
import { ApiView, DeployView } from "@/app/_workbench/ServiceViews";
import { agreementsClient, type AgreementDetail } from "@/lib/agreements";
import type { Verification } from "@/lib/types";
import { compiled } from "./fixtures";

const liveReport: Verification = {
  provider: "noolog",
  mock: false,
  jobId: "test-job",
  agents: ["critic"],
  rounds: 1,
  winner: null,
  convergence: null,
  claims: [
    {
      key: "quote",
      ref: "rule:a",
      claim: "Source matches",
      verdicts: [{ agent: "critic", verdict: "verified", reason: "verbatim" }],
      disputed: false,
      score: 1,
    },
  ],
  contested: [],
  confidence: {
    overall: 1,
    verified: 1,
    total: 1,
    byRef: { "rule:a": 1 },
    counts: { verified: 1, contested: 0, unverified: 0, wrong: 0, unknown: 0 },
  },
};

describe("source-linked workbench", () => {
  it("derives sample nodes from real compiler exports without fabricating verification", async () => {
    const policy = await compiled("rwa-secondary");
    const graph = sampleGraph(policy);
    expect(graph.nodes.filter((node) => node.kind === "rule")).toHaveLength(policy.rules.length);
    for (const rule of policy.rules) {
      const ref = `rule:${rule.id}`;
      expect(graph.nodes.find((node) => node.id === ref)).toMatchObject({
        clauseId: rule.clauseId,
        clause: rule.source.clause,
      });
      expect(graph.edges).toContainEqual({ from: `action:${rule.action}`, to: ref });
      expect(dnfText(policy, ref)).not.toBe("");
    }
    expect(graph.nodes.every((node) => node.status === undefined)).toBe(true);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
  });
  it("lays out every graph node and only connects existing endpoints", async () => {
    const graph = sampleGraph(await compiled("wildcat-credit"));
    const layout = layoutGraph(graph);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
    expect(layout.edges.every((edge) => edge.d.startsWith("M ") && !edge.d.includes("NaN"))).toBe(true);
    expect(new Set(layout.edges.map((edge) => edge.key)).size).toBe(layout.edges.length);
    const filtered = graphForAction(graph, "deposit");
    expect(filtered.nodes.filter((node) => node.kind === "action").map((node) => node.label)).toEqual([
      "deposit",
    ]);
    for (const edge of filtered.edges)
      expect(
        filtered.nodes.some((node) => node.id === edge.from) &&
          filtered.nodes.some((node) => node.id === edge.to)
      ).toBe(true);
  });
  it("uses the same accessible selection and color for source cards and AST nodes", async () => {
    const policy = await compiled("rwa-secondary");
    const selected = `rule:${policy.rules[0].id}`;
    const cards = renderToStaticMarkup(createElement(SourceCards, { policy, selected, onSelect: () => {} }));
    const graph = renderToStaticMarkup(
      createElement(GraphPane, {
        graph: sampleGraph(policy),
        policy,
        selected,
        sample: true,
        onSelect: () => {},
      })
    );
    expect(cards).toContain('aria-pressed="true"');
    expect(graph).toContain('aria-pressed="true"');
    expect(cards).toContain(`wb-tone-${nodeTone(selected, policy)}`);
    expect(graph).toContain(`wb-tone-${nodeTone(selected, policy)}`);
    expect(graph).toContain("Export-derived graph");
    expect(graph).toContain('aria-label="Zoom in"');
    expect(cards).toContain("unresolved · not enforced");
  });
  it("escapes uploaded source text instead of rendering HTML", async () => {
    const policy = structuredClone(await compiled("rwa-secondary"));
    policy.rules[0].source.quote = "<script>alert('no')</script>";
    const html = renderToStaticMarkup(
      createElement(SourceCards, { policy, selected: "", onSelect: () => {} })
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("only labels verified claims when a non-mock report has provenance", async () => {
    const policy = { ...(await compiled("rwa-secondary")), verification: liveReport };
    expect(verificationLabel(policy, false)).toBe("Extraction: 1/1 claims verified");
    expect(verificationLabel(policy, true)).toBe("Sample · exported policy");
    expect(verificationLabel({ ...policy, verification: { ...liveReport, mock: true } }, false)).toBe(
      "Mock extraction report"
    );
    expect(verificationLabel({ ...policy, verification: { ...liveReport, jobId: "" } }, false)).toBe(
      "No live verification evidence"
    );
    expect(verificationLabel({ ...policy, verification: undefined }, false)).toBe(
      "No live verification evidence"
    );
    const html = renderToStaticMarkup(createElement(Evidence, { policy, sample: false }));
    expect(html).toContain("test-job");
    expect(html).toContain("exhaustive equivalence checks (not Z3)");
    expect(html).toContain("Issuer-added identity constraints are separate decisions");
  });
  it("never treats a sample as deployed and shows a safe NAV caveat", async () => {
    const policy = await compiled("rwa-secondary");
    const record = {
      id: "sample:rwa-secondary",
      name: "Sample",
      profile: policy.profile,
      status: "compiled",
      policyHash: policy.policyHash,
      deployment: null,
      export: policy,
      history: [],
    } as unknown as AgreementDetail;
    const html = renderToStaticMarkup(
      createElement(DeployView, {
        record,
        policy,
        constraints: null,
        constraintError: "",
        sample: true,
        writable: false,
        busy: false,
        status: null,
        client: agreementsClient({ url: "", viewerKey: "", operatorKey: "", revision: 0 }),
        blocked: "Connect with an operator key to deploy.",
        onDeploy: () => {},
        onConstrain: () => {},
      })
    );
    expect(html).toContain("No current deployment reported");
    expect(html).toContain("No live NAV or cashier integration is asserted");
    expect(html).toContain("disabled");
    const api = renderToStaticMarkup(
      createElement(ApiView, { record, policy, sample: true, baseUrl: "", refresh: () => {} })
    );
    expect(api).toContain("documented route shapes, not live responses");
    expect(api).toContain("/v1/agreements/:id/constraints");
  });
});
