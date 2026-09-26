import type { AgreementDetail, AstGraph, AstNode } from "./agreements";
import type { Condition, PolicyData, ProfileSummary } from "./types";

export const tones = ["cyan", "blue", "amber", "purple"] as const;
export function nodeTone(id: string, policy: PolicyData): string {
  const index = [
    ...policy.rules.map((rule) => `rule:${rule.id}`),
    ...policy.terms.map((term) => `term:${term.name}`),
  ].indexOf(id);
  return id.startsWith("unresolved:") ? "amber" : tones[Math.max(0, index) % tones.length];
}
export function factsOf(condition: Condition): string[] {
  if (condition.type === "fact") return [condition.name];
  if (condition.type === "not") return factsOf(condition.child);
  return condition.children.flatMap(factsOf);
}

/** Only used for explicitly labelled sample exports. Live graphs always come from /ast. */
export function sampleGraph(policy: PolicyData): AstGraph {
  const nodes = new Map<string, AstNode>([
    ["agreement", { id: "agreement", kind: "agreement", label: policy.title }],
  ]);
  const edges = new Map<string, { from: string; to: string }>();
  const link = (from: string, node: AstNode) => {
    nodes.set(node.id, node);
    edges.set(`${from}/${node.id}`, { from, to: node.id });
  };
  for (const rule of policy.rules) {
    link("agreement", { id: `action:${rule.action}`, kind: "action", label: rule.action });
    link(`action:${rule.action}`, {
      id: `rule:${rule.id}`,
      kind: "rule",
      label: rule.id,
      clause: rule.source.clause,
      clauseId: rule.clauseId,
      effect: rule.effect,
    });
    for (const fact of new Set(factsOf(rule.condition)))
      link(`rule:${rule.id}`, { id: `fact:${fact}`, kind: "fact", label: fact });
  }
  for (const term of policy.terms)
    link("agreement", {
      id: `term:${term.name}`,
      kind: "term",
      label: term.name,
      clause: term.source.clause,
      value: term.value,
    });
  policy.unresolved.forEach((item, index) =>
    link("agreement", {
      id: `unresolved:${index}`,
      kind: "unresolved",
      label: item.clause,
      description: item.description,
    })
  );
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
export function sampleSummary(profile: ProfileSummary): AgreementDetail {
  return {
    id: `sample:${profile.profile}`,
    name: profile.title.replace(" — executable subset", ""),
    profile: profile.profile,
    status: "compiled",
    createdAt: "",
    updatedAt: "",
    source: { name: "", sha256: "", textSha256: "" },
    extraction: null,
    verification: null,
    policyHash: profile.policyHash,
    clauseTableHash: null,
    coverage: profile.coverage ?? null,
    deployment: null,
    error: null,
    history: [],
    export: null,
  };
}
export function verificationLabel(policy: PolicyData | null, sample: boolean): string {
  if (sample) return "Sample · exported policy";
  if (policy?.extraction?.provider === "openai")
    return "OpenAI AST · quotes validated, no independent review";
  if (policy?.extraction?.provider === "demo") return "Demo AST · deterministic fixture";
  const report = policy?.verification;
  if (report?.mock) return "Mock extraction report";
  if (
    !report ||
    report.mock !== false ||
    !report.jobId ||
    !report.agents.length ||
    !report.claims.length ||
    !policy?.source.sha256 ||
    !policy.extraction?.provider
  )
    return "No live verification evidence";
  return `Extraction: ${report.confidence.verified}/${report.confidence.total} claims verified`;
}

export function graphForAction(graph: AstGraph, action: string): AstGraph {
  if (!action) return graph;
  const ids = new Set(["agreement", `action:${action}`]);
  graph.edges.filter((edge) => edge.from === `action:${action}`).forEach((edge) => ids.add(edge.to));
  graph.edges
    .filter((edge) => ids.has(edge.from) && edge.from !== "agreement")
    .forEach((edge) => ids.add(edge.to));
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}
export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 74;
export function layoutGraph(graph: AstGraph, columns = 3) {
  const lanes: AstNode[][] = [[], [], [], []];
  for (const node of graph.nodes)
    lanes[node.kind === "agreement" ? 0 : node.kind === "action" ? 1 : node.kind === "fact" ? 3 : 2].push(
      node
    );
  const width = columns * (NODE_WIDTH + 26) + 30;
  let top = 30;
  const nodes = lanes.flatMap((lane) => {
    const start = top;
    if (lane.length) top += Math.ceil(lane.length / columns) * 118 + 28;
    return lane.map((node, index) => {
      const row = Math.floor(index / columns);
      const rowSize = Math.min(columns, lane.length - row * columns);
      return {
        ...node,
        x: (width - rowSize * (NODE_WIDTH + 26) + 26) / 2 + (index % columns) * (NODE_WIDTH + 26),
        y: start + row * 118,
      };
    });
  });
  const height = Math.max(320, top);
  const positions = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const edges = graph.edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const key = `${edge.from}/${edge.to}`;
    if (!from || !to || seen.has(key)) return [];
    seen.add(key);
    const x = from.x + NODE_WIDTH / 2;
    const y = from.y + NODE_HEIGHT;
    const endX = to.x + NODE_WIDTH / 2;
    const midY = y + (to.y - y) / 2;
    return [{ ...edge, key, d: `M ${x} ${y} C ${x} ${midY}, ${endX} ${midY}, ${endX} ${to.y}` }];
  });
  return { nodes, edges, width, height };
}
export function dnfText(policy: PolicyData, id: string): string {
  const rule = policy.rules.find((entry) => `rule:${entry.id}` === id);
  if (!rule) return "";
  return (
    rule.dnf
      .map(
        (term) =>
          [
            ...term.pos.map((bit) => policy.factOrder[bit]),
            ...term.neg.map((bit) => `NOT ${policy.factOrder[bit]}`),
          ].join(" AND ") || "TRUE"
      )
      .join(" OR ") || "FALSE"
  );
}
