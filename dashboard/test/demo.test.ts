import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadDemoBundle, DEMO_FILES } from "@/lib/demo";
import { validateUpload, type AgreementDetail, type Upload } from "@/lib/agreements";
import { AnalysisView } from "@/app/_workbench/AnalysisView";
import { Agreements } from "../../src/agreements.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function mockStaticFiles() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) => new Response(await readFile(new URL(`../public${url}`, import.meta.url), "utf8"))
    )
  );
  return loadDemoBundle();
}
describe("real demo document upload", () => {
  it("ships exact copies of backend source documents and opt-in config", async () => {
    for (const file of DEMO_FILES) {
      const source =
        file.role === "config" ? `../../examples/${file.name}` : `../../test/human_contracts/${file.name}`;
      expect(await readFile(new URL(`../public/demo/${file.name}`, import.meta.url), "utf8")).toBe(
        await readFile(new URL(source, import.meta.url), "utf8")
      );
    }
    const upload = await mockStaticFiles();
    expect(upload.documents.map((file) => file.name)).toEqual([
      "ea026411904ex10-9.htm",
      "nav-cashier-addendum.md",
    ]);
    expect(upload.config?.cashier).toEqual({ enabled: true, pool: { fee: 3000, tickSpacing: 60 } });
    expect(() => validateUpload(upload)).not.toThrow();
    expect(upload.documents[1].text).toContain("not part of the base BUIDL agreement");
  });
  it("uses the explicit deterministic fixture to produce a real compiled report", async () => {
    const upload = await mockStaticFiles();
    vi.unstubAllGlobals();
    vi.stubEnv("OPENAI_API_KEY", "");
    // The backend is untyped JS; its inferred default config:null is narrower than the REST contract.
    const store = (await new Agreements().init()) as unknown as {
      create(upload: Upload): Promise<{ id: string }>;
      settled(): Promise<unknown>;
      get(id: string): AgreementDetail;
    };
    const created = await store.create({ ...upload, generation: "demo" });
    await store.settled();
    const record = store.get(created.id) as AgreementDetail;
    expect(record.status, record.error ?? "").toBe("compiled");
    expect(record.export?.verification).toBeNull();
    expect(record.extraction?.provider).toBe("demo");
    expect(record.export?.equivalenceChecks).toBeGreaterThan(0);
    expect(record.export?.documents).toHaveLength(2);
    expect(record.export?.config.cashier).toMatchObject({ enabled: true });
    const html = renderToStaticMarkup(
      createElement(AnalysisView, { record, sample: false, onAst: () => {}, onIdentity: () => {} })
    );
    expect(html).toContain("Demo AST");
    expect(html).toContain("deterministic fixture");
    const regenerating = {
      ...record,
      export: null,
      status: "extracting",
      history: [...record.history, { status: "extracting", at: new Date().toISOString() }],
    } as AgreementDetail;
    const current = renderToStaticMarkup(
      createElement(AnalysisView, {
        record: regenerating,
        sample: false,
        onAst: () => {},
        onIdentity: () => {},
      })
    );
    expect(current).toContain('data-complete="false"><strong>Compile &amp; equivalence');
  });
});

describe("short template", () => {
  it("loads the short agreement served beside the demo bundle", async () => {
    await mockStaticFiles();
    const { loadShortTemplate, SHORT_TEMPLATE } = await import("@/lib/demo");
    const template = await loadShortTemplate();
    expect(template.name).toBe(SHORT_TEMPLATE);
    expect(template.text).toContain("Tokenized Fund Share Agreement");
    expect(new TextEncoder().encode(template.text).length).toBeLessThan(4000);
  });
});
