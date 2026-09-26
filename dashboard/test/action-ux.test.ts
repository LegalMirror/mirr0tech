import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { actionError, addressError, amountError } from "@/lib/validate";
import { GatewayError } from "@/lib/session";
import {
  operationLabel,
  operationSettled,
  type AgreementDetail,
  type AgreementsClient,
  type StackStatus,
} from "@/lib/agreements";
import { WalletChanged } from "@/lib/investor/wallet";
import { Busy, FieldError } from "@/app/_workbench/ui";
import { MintView } from "@/app/_workbench/MintView";
import { SeedPoolCard } from "@/app/_workbench/SeedPoolCard";
import { MockUsdFaucet } from "@/app/_workbench/MockUsdFaucet";

const token = `0x${"1".repeat(40)}`;
const backend = `0x${"2".repeat(40)}`;

describe("amountError", () => {
  it("accepts positive decimal amounts with at most six places", () => {
    for (const value of ["1", "0.000001", "100.5", "1234.567891", " 42 "])
      expect(amountError(value)).toBeNull();
  });
  it("requires a value", () => {
    expect(amountError("")).toBe("Enter an amount.");
    expect(amountError("   ")).toBe("Enter an amount.");
  });
  it("rejects anything that is not a plain positive number", () => {
    for (const value of ["abc", "-1", "1e6", "1,000", ".5", "1.", "0x10", "NaN"])
      expect(amountError(value)).toBe("Enter a number such as 100 or 12.5.");
  });
  it("rejects more than six decimals", () => {
    expect(amountError("0.0000001")).toBe("Use at most 6 decimal places.");
  });
  it("rejects zero", () => {
    for (const value of ["0", "0.0", "0.000000"])
      expect(amountError(value)).toBe("Enter an amount greater than 0.");
  });
});

describe("addressError", () => {
  it("accepts lowercase and correctly checksummed addresses", () => {
    expect(addressError(token)).toBeNull();
    expect(addressError("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBeNull();
  });
  it("requires a value", () => {
    expect(addressError("")).toBe("Enter a recipient address.");
    expect(addressError("  ")).toBe("Enter a recipient address.");
  });
  it("rejects malformed, mis-checksummed and zero addresses", () => {
    for (const value of ["0x123", "1".repeat(40), `0x${"g".repeat(40)}`])
      expect(addressError(value)).toBe("Enter a 0x address with 40 hex characters.");
    expect(addressError("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toContain("checksum");
    expect(addressError(`0x${"0".repeat(40)}`)).toBe("The zero address cannot receive tokens.");
  });
});

describe("actionError", () => {
  it("shows the gateway's message with its error code", () => {
    expect(actionError(new GatewayError("Recipient is not eligible.", 422, "MINT_REJECTED"))).toBe(
      "Recipient is not eligible. (MINT_REJECTED)"
    );
  });
  it("omits the synthetic code when the gateway sent no error body", () => {
    expect(actionError(new GatewayError("POST /v1/x: 502", 502, "HTTP_ERROR"))).toBe("POST /v1/x: 502");
  });
  it("explains wallet rejections and wallet changes", () => {
    expect(actionError({ code: 4001, message: "User rejected" })).toContain("Wallet request rejected");
    expect(actionError(new WalletChanged())).toContain("wallet account or chain changed");
  });
  it("keeps plain error messages and never returns an empty string", () => {
    expect(actionError(new Error("Swap failed. Check Etherscan."))).toBe("Swap failed. Check Etherscan.");
    expect(actionError("boom")).not.toBe("");
  });
});

describe("operation progress", () => {
  it("settles once, when an operation first reaches confirmed", () => {
    expect(operationSettled({ status: "pending" }, { status: "confirmed" })).toBe(true);
    expect(operationSettled(null, { status: "confirmed" })).toBe(true);
    expect(operationSettled({ status: "confirmed" }, { status: "confirmed" })).toBe(false);
    expect(operationSettled({ status: "pending" }, { status: "pending" })).toBe(false);
    expect(operationSettled({ status: "pending" }, { status: "failed" })).toBe(false);
  });
  it("names the stage a pending operation is waiting on", () => {
    expect(operationLabel("approval")).toBe("Approving tokens…");
    expect(operationLabel("mint")).toBe("Minting…");
    expect(operationLabel("release")).toBe("Releasing tokens…");
    expect(operationLabel("seed")).toBe("Seeding pool…");
    expect(operationLabel("complete")).toBe("Waiting for confirmation…");
  });
});

describe("action feedback components", () => {
  it("renders the shared spinner with a state label", () => {
    const html = renderToStaticMarkup(createElement(Busy, { label: "Minting…" }));
    expect(html).toContain('class="wb-spinner"');
    expect(html).toContain("Minting…");
  });
  it("renders an inline field error only when there is one", () => {
    expect(renderToStaticMarkup(createElement(FieldError, { error: "Enter an amount." }))).toContain(
      "Enter an amount."
    );
    expect(renderToStaticMarkup(createElement(FieldError, { error: null }))).toBe("");
  });
});

const record = {
  id: "agr_ux",
  status: "deployed",
  profile: "rwa-secondary",
  policyHash: "hash",
  deployment: { token, policyHash: "hash", chainId: 11155111, poolId: "pool", routing: "uniswap-api" },
} as AgreementDetail;
const client = {} as AgreementsClient;
const status = { chain: { chainId: 11155111, deployer: backend } } as StackStatus;
const mint = (extra: Partial<AgreementDetail>) =>
  renderToStaticMarkup(
    createElement(MintView, {
      record: { ...record, ...extra },
      client,
      sample: false,
      writable: true,
      status,
    })
  );
const pendingButton = (label: string) =>
  new RegExp(
    `<button class="wb-primary" disabled="">[^<]*<span class="wb-spinner"[^>]*></span>${label}</button>`
  );

describe("workbench actions while pending", () => {
  it("disables minting and shows a spinner with the stage while a mint is pending", () => {
    const html = mint({
      mintOperations: [
        { requestId: "r1", recipient: backend, amount: "5", status: "pending", stage: "release" } as never,
      ],
    });
    expect(html).toMatch(pendingButton("Releasing tokens…"));
    expect(html).not.toContain(">Review mint<");
  });
  it("shows a gateway failure on the mint operation as an error notice", () => {
    const html = mint({
      mintOperations: [
        {
          requestId: "r1",
          recipient: backend,
          amount: "5",
          status: "failed",
          stage: "mint",
          error: "Recipient is not eligible. (MINT_REJECTED)",
        } as never,
      ],
    });
    expect(html).toContain('role="alert">Recipient is not eligible. (MINT_REJECTED)');
  });
  it("disables seeding and shows a spinner with the stage while a seed is pending", () => {
    const html = renderToStaticMarkup(
      createElement(SeedPoolCard, {
        record: {
          ...record,
          seedOperations: [
            {
              requestId: "s1",
              rwaAmount: "1",
              usdAmount: "1",
              poolId: "pool",
              status: "pending",
              stage: "approval",
            },
          ],
        },
        client,
        blocked: null,
      })
    );
    expect(html).toMatch(pendingButton("Approving tokens…"));
    expect(html).not.toContain(">Review seed<");
  });
  it("keeps idle actions free of spinners and validation errors", () => {
    expect(mint({})).not.toContain("wb-spinner");
    expect(mint({})).not.toContain("wb-field-error");
    const faucet = renderToStaticMarkup(createElement(MockUsdFaucet, { onBusyChange: () => {} }));
    expect(faucet).not.toContain("wb-field-error");
    expect(faucet).not.toContain("wb-spinner");
  });
});
