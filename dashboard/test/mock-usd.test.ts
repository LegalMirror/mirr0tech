import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Interface, parseUnits } from "ethers";
import { MOCK_USD, MOCK_USD_ABI, mockUsdMintTransaction } from "@/lib/mock-usd";
import { MockUsdFaucet } from "@/app/_workbench/MockUsdFaucet";
import { SettingsDialog } from "@/app/_workbench/Forms";

const wallet = { address: `0x${"1".repeat(40)}`, chainId: 11155111 };
describe("shared mUSDC faucet", () => {
  it("encodes mint to the connected wallet on the saved six-decimal deployment", () => {
    const tx = mockUsdMintTransaction(wallet, "1234.567891");
    expect(tx.to).toBe(MOCK_USD.address);
    expect(tx.from).toBe(wallet.address);
    expect(tx.value).toBe("0x0");
    const args = new Interface(MOCK_USD_ABI).decodeFunctionData("mint", tx.data);
    expect(args[0]).toBe(wallet.address);
    expect(args[1]).toBe(1234567891n);
    expect(MOCK_USD.decimals).toBe(6);
  });
  it("allows large amounts with no faucet quota and rejects invalid units or the wrong chain", () => {
    const amount = "1000000000000000000";
    const tx = mockUsdMintTransaction(wallet, amount);
    expect(new Interface(MOCK_USD_ABI).decodeFunctionData("mint", tx.data)[1]).toBe(parseUnits(amount, 6));
    for (const value of ["0", "-1", "0.0000001", "1e6", "", "NaN"])
      expect(() => mockUsdMintTransaction(wallet, value)).toThrow();
    expect(() => mockUsdMintTransaction({ ...wallet, chainId: 1 }, "10")).toThrow("Sepolia");
  });
  it("exposes the deployed faucet under Settings without a gateway credential", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, {
        session: { url: "", viewerKey: "", operatorKey: "", revision: 0 },
        sample: true,
        status: null,
        statusError: "",
        onClose: () => {},
      })
    );
    expect(html).toContain("Test-token faucet");
    expect(html).toContain("Connect wallet to mint");
    expect(html).toContain(`https://sepolia.etherscan.io/address/${MOCK_USD.address}`);
    const faucet = renderToStaticMarkup(createElement(MockUsdFaucet, { onBusyChange: () => {} }));
    expect(faucet).toContain("no cap or cooldown");
    expect(faucet).toContain("Sepolia ETH");
  });
});
