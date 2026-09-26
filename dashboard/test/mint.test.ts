import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MintView } from "@/app/_workbench/MintView";
import type { AgreementDetail, AgreementsClient, StackStatus } from "@/lib/agreements";

const token = `0x${"1".repeat(40)}`;
const backend = `0x${"2".repeat(40)}`;
const record = {
  id: "agr_test",
  status: "deployed",
  profile: "rwa-secondary",
  policyHash: "hash",
  deployment: { token, policyHash: "hash", chainId: 11155111 },
} as AgreementDetail;
const status = { chain: { chainId: 11155111, deployer: backend } } as StackStatus;
const client = {} as AgreementsClient;
const render = (extra = {}) =>
  renderToStaticMarkup(
    createElement(MintView, { record, status, client, sample: false, writable: true, ...extra })
  );
it("offers recipient and amount inputs with the backend minter and deployed token", () => {
  const html = render();
  expect(html).toContain("Recipient address");
  expect(html).toContain("Amount of RWA tokens");
  expect(html).toContain("Review mint");
  expect(html).toContain(`https://sepolia.etherscan.io/address/${backend}`);
  expect(html).toContain(`https://sepolia.etherscan.io/address/${token}`);
  expect(html).not.toContain("Connect wallet");
});
it("blocks samples, viewers, undeployed agreements and separate settlement flows", () => {
  expect(render({ sample: true })).toContain("Samples are read-only");
  expect(render({ writable: false })).toContain("authorized local workspace or operator");
  expect(render({ record: { ...record, status: "compiled", deployment: null } })).toContain(
    "Deploy this agreement before minting"
  );
  expect(
    render({ record: { ...record, deployment: { ...record.deployment, cashier: { enabled: true } } } })
  ).toContain("separate settlement flow");
});
it("shows both transaction links and a same-request retry for a failed release", () => {
  const html = render({
    record: {
      ...record,
      mintOperations: [
        {
          requestId: "request-0000000001",
          recipient: backend,
          amount: "100",
          status: "failed",
          stage: "release",
          minted: true,
          mintTxHash: "0xmint",
          releaseTxHash: "0xrelease",
        },
      ],
    },
  });
  expect(html).toContain("Retry same request");
  expect(html).toContain("without minting again");
  expect(html).toContain("https://sepolia.etherscan.io/tx/0xmint");
  expect(html).toContain("https://sepolia.etherscan.io/tx/0xrelease");
});
it("offers an unchecked subscription bypass with explicit limits below minting", () => {
  const html = render();
  expect(html).toContain("Liquidity management");
  expect(html).toContain("Advanced settings");
  expect(html).toContain("Bypass subscription acceptance");
  expect(html).toContain("subscriptionAccepted=true");
  expect(html).toContain("Simulate bank deposit (testnet only)");
  expect(html).toContain("Off by default");
  expect(html).toContain("Other requirements, including payment, KYC/AML and World ID, still apply");
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain('checked=""');
  expect(html).toContain("Seed Uniswap pool");
  expect(html.indexOf("Advanced settings")).toBeGreaterThan(html.indexOf("Mint RWA tokens"));
  expect(html.indexOf("Seed Uniswap pool")).toBeGreaterThan(html.indexOf("Advanced settings"));
});
it("disables seeding deprecated token pairs", () => {
  const html = render({
    record: {
      ...record,
      deployment: { ...record.deployment, poolId: "pool", poolKey: { currency0: token, currency1: backend } },
    },
  });
  expect(html).toContain("Seeding is disabled for this deprecated pool");
});

it("exposes every remaining mint and release simulation with all checkboxes off", () => {
  const html = render();
  for (const label of [
    "Simulate issuer authorization",
    "Simulate offering compliance",
    "Simulate World ID verification",
    "Simulate KYC approval",
    "Simulate AML approval",
    "Simulate sanctions clearance",
  ])
    expect(html).toContain(label);
  expect((html.match(/type="checkbox"/g) ?? []).length).toBe(8);
  expect(html).not.toContain('checked=""');
  expect(html).toContain("without a World ID proof");
  expect(html).toContain("mock sanctions oracle");
});
