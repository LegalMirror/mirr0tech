export type LegalSource = {
  documentId: string;
  quote: string;
  occurrence: number;
  start: number;
  end: number;
};
export type LegalNode = {
  id: string;
  kind:
    | "section"
    | "clause"
    | "definition"
    | "obligation"
    | "permission"
    | "prohibition"
    | "condition"
    | "exception"
    | "party"
    | "remedy"
    | "date"
    | "amount";
  label: string;
  summary: string;
  parentId: string | null;
  source: LegalSource;
};
export type LegalRelation = {
  id: string;
  from: string;
  to: string;
  kind:
    "references" | "defines" | "applies_to" | "requires" | "excepts" | "overrides" | "amends" | "party_to";
  source: LegalSource;
};
export type LegalAst = {
  schemaVersion: "2.0";
  title: string;
  documents: { id: string; name: string; sha256: string; textSha256: string; text: string }[];
  nodes: LegalNode[];
  relations: LegalRelation[];
  issues: { nodeId: string | null; description: string }[];
};
export function isLegalAst(ast: unknown): ast is LegalAst {
  return !!ast && typeof ast === "object" && "schemaVersion" in ast && ast.schemaVersion === "2.0";
}
export function astDownload(ast: unknown, name: string) {
  return {
    filename: `${
      name
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "contract"
    }.ast.json`,
    json: `${JSON.stringify(ast, null, 2)}\n`,
  };
}
export function downloadAst(ast: unknown, name: string) {
  const { filename, json } = astDownload(ast, name);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function legalGraph(ast: LegalAst, selected: string, focused: boolean) {
  const root = { id: "agreement", label: ast.title, kind: "agreement", parentId: null as string | null };
  const all = [
    root,
    ...ast.documents.map((doc) => ({ id: doc.id, label: doc.name, kind: "document", parentId: root.id })),
    ...ast.nodes.map((node) => ({ ...node, parentId: node.parentId ?? node.source.documentId })),
  ];
  const edges = [
    ...all
      .filter((node) => node.parentId)
      .map((node) => ({ from: node.parentId!, to: node.id, kind: "contains" })),
    ...ast.relations,
  ];
  const byId = new Map(all.map((node) => [node.id, node]));
  const ids = new Set([selected]);
  if (focused && byId.has(selected)) {
    for (const edge of edges)
      if (edge.from === selected || edge.to === selected) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    for (const id of [...ids]) {
      let parent = byId.get(id)?.parentId;
      while (parent) {
        ids.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
  } else all.forEach((node) => ids.add(node.id));
  const rows = new Map<number, number>();
  const nodes = all
    .filter((node) => ids.has(node.id))
    .map((node) => {
      let depth = 0,
        parent = node.parentId;
      while (parent) {
        depth++;
        parent = byId.get(parent)?.parentId ?? null;
      }
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return { ...node, x: 24 + depth * 252, y: 24 + row * 112 };
    });
  const positions = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes,
    edges: edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => {
        const from = positions.get(edge.from)!,
          to = positions.get(edge.to)!;
        const x = from.x + 210,
          y = from.y + 42,
          endX = to.x,
          endY = to.y + 42;
        const bend = Math.max(40, Math.abs(endX - x) / 2);
        return {
          ...edge,
          key: `${edge.from}/${edge.kind}/${edge.to}`,
          d: `M ${x} ${y} C ${x + bend} ${y}, ${endX - bend} ${endY}, ${endX} ${endY}`,
        };
      }),
    width: Math.max(620, ...nodes.map((node) => node.x + 234)),
    height: Math.max(360, ...nodes.map((node) => node.y + 112)),
  };
}
