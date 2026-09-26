import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { generationFor } from "@/lib/agreements";
import { UploadDialog } from "@/app/_workbench/Forms";

it("a gateway that reads with Noolog gets every upload deliberated, without asking", () => {
  expect(generationFor({ provider: "noolog", localWorkspace: false, mode: "demo" })).toBe("noolog");
  expect(generationFor({ provider: "noolog", localWorkspace: true, mode: "files" })).toBe("noolog");
});

it("otherwise a local workspace picks the fixture or OpenAI, and a hosted one leaves it to the gateway", () => {
  expect(generationFor({ provider: "openai", localWorkspace: true, mode: "demo" })).toBe("demo");
  expect(generationFor({ provider: "openai", localWorkspace: true, mode: "files" })).toBe("openai");
  expect(generationFor({ provider: undefined, localWorkspace: false, mode: "files" })).toBeUndefined();
});

it("the upload dialog offers no Noolog toggle", () => {
  const html = renderToStaticMarkup(
    createElement(UploadDialog, { onClose: () => {}, onUpload: async () => {}, writable: true, status: null })
  );
  expect(html).not.toContain("Deliberate with Noolog");
});
