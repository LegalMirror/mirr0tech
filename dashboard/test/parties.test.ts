import { describe, expect, it } from "vitest";
import { relevantFacts, statusAction } from "@/lib/parties";
import type { PolicyData } from "@/lib/types";

const policy = {
  factOrder: ["kycApproved", "sanctionsClear", "mlaCountersigned", "openTermState"],
  actionOrder: ["deposit", "withdraw"],
  rules: [
    {
      action: "deposit",
      condition: {
        type: "all",
        children: [
          { type: "fact", name: "mlaCountersigned" },
          { type: "not", child: { type: "fact", name: "sanctionsClear" } },
        ],
      },
    },
    { action: "withdraw", condition: { type: "fact", name: "openTermState" } },
  ],
} as unknown as PolicyData;

describe("relevantFacts", () => {
  it("keeps only facts some rule reads, in bit order", () => {
    expect(relevantFacts(policy)).toEqual(["sanctionsClear", "mlaCountersigned", "openTermState"]);
  });
});

describe("statusAction", () => {
  it("is admission for lenders, the pool door for trading, issuance under custody", () => {
    const of = (profile: string) => statusAction({ profile } as PolicyData);
    expect(of("wildcat-credit")).toBe("deposit");
    expect(of("rwa-secondary")).toBe("transfer");
    expect(of("custodial-rwa")).toBe("mint");
  });
});
