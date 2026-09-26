import { describe, expect, it } from "vitest";
import { ACTS, VISIBLE_PROFILES, visibleProfile } from "@/lib/acts";

describe("acts", () => {
  it("shows two acts and folds the custody-only reading into the fund act", () => {
    expect(ACTS.map((a) => a.label)).toEqual(["Fund", "Loan"]);
    expect(VISIBLE_PROFILES).toEqual(["rwa-secondary", "wildcat-credit"]);
    expect(visibleProfile("custodial-rwa")).toBe("rwa-secondary");
    expect(visibleProfile("wildcat-credit")).toBe("wildcat-credit");
  });
});
