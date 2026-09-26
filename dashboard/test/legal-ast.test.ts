import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { astDownload, downloadAst, legalGraph, type LegalAst } from "@/lib/legal-ast";
import { canRegenerate, inFlight } from "@/lib/agreements";
import { LegalAstView } from "@/app/_workbench/LegalAstView";

const text = "Pay USD 100. Except during a dispute. <script>not executable</script>";
const citation = (quote: string) => ({
  documentId: "document-1",
  quote,
  occurrence: 0,
  start: text.indexOf(quote),
  end: text.indexOf(quote) + quote.length,
});
const ast: LegalAst = {
  schemaVersion: "2.0",
  title: "Services / contract",
  documents: [{ id: "document-1", name: "services.txt", text, sha256: "raw-hash", textSha256: "text-hash" }],
  nodes: [
    {
      id: "payment",
      kind: "clause",
      label: "Payment",
      summary: "Pay USD 100.",
      parentId: null,
      source: citation("Pay USD 100."),
    },
    {
      id: "exception",
      kind: "exception",
      label: "Dispute",
      summary: "Payment exception.",
      parentId: null,
      source: citation("Except during a dispute."),
    },
    {
      id: "other",
      kind: "clause",
      label: "Other clause",
      summary: "Text only",
      parentId: null,
      source: citation("<script>not executable</script>"),
    },
  ],
  relations: [
    {
      id: "except-payment",
      from: "exception",
      to: "payment",
      kind: "excepts",
      source: citation("Except during a dispute."),
    },
  ],
  issues: [{ nodeId: "exception", description: "Dispute is not defined." }],
};

describe("legal document graph", () => {
  it("keeps relationship direction, hierarchy and full-data export under focused selection", () => {
    const graph = legalGraph(ast, "payment", true);
    expect(graph.nodes.map((node) => node.id)).toEqual(["agreement", "document-1", "payment", "exception"]);
    expect(graph.edges.find((edge) => edge.kind === "excepts")).toMatchObject({
      from: "exception",
      to: "payment",
    });
    expect(graph.edges.every((edge) => !edge.d.includes("NaN"))).toBe(true);
    expect(legalGraph(ast, "payment", false).nodes).toHaveLength(5);
    const download = astDownload(ast, ast.title);
    expect(download.filename).toBe("Services-contract.ast.json");
    expect(JSON.parse(download.json)).toEqual(ast);
    expect(JSON.parse(download.json).nodes).toHaveLength(3);
  });

  it("renders linked source cards, selected nodes, evidence and a download without a compiled policy", () => {
    const html = renderToStaticMarkup(
      createElement(LegalAstView, { ast, selected: "exception", onSelect: () => {} })
    );
    expect(html.match(/data-node="exception" aria-pressed="true"|aria-pressed="true"/g)?.length).toBe(2);
    expect(html).toContain("Download AST JSON");
    expect(html).toContain("excepts");
    expect(html).toContain("Dispute is not defined.");
    expect(html).not.toContain("<script>");
    const source = renderToStaticMarkup(
      createElement(LegalAstView, { ast, selected: "payment", onSelect: () => {}, human: true })
    );
    expect(source).toContain("<mark>Pay USD 100.</mark>");
    expect(source).toContain("&lt;script&gt;");
    expect(inFlight("analyzed")).toBe(false);
    expect(canRegenerate("analyzed")).toBe(true);
  });

  it("downloads complete JSON with a safe filename and releases the object URL", async () => {
    vi.useFakeTimers();
    const click = vi.fn(),
      remove = vi.fn(),
      appendChild = vi.fn();
    const link = { href: "", download: "", click, remove };
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ast");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("document", { createElement: () => link, body: { appendChild } });
    try {
      downloadAst(ast, "../../services");
      expect(link.download).toBe("services.ast.json");
      expect(click).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      const blob = create.mock.calls[0][0] as Blob;
      expect(JSON.parse(await blob.text())).toEqual(ast);
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:ast");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
