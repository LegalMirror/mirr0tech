import { describe, expect, it } from "vitest";
import { auctionCurve, auctionPrice } from "@/lib/auction";

describe("auctionPrice", () => {
  it("opens at the floor, closes at the ceiling, improves in between and clamps outside the window", () => {
    expect(auctionPrice(0.96, 1, 6, 0)).toBeCloseTo(0.96, 6);
    expect(auctionPrice(0.96, 1, 6, 6)).toBeCloseTo(1, 6);
    expect(auctionPrice(0.96, 1, 6, 3)).toBeCloseTo(0.9798, 3);
    expect(auctionPrice(0.96, 1, 6, 9)).toBeCloseTo(1, 6);
    const curve = auctionCurve(0.96, 1, 6, 7);
    expect(curve).toHaveLength(7);
    expect(curve.every(([, p], i) => i === 0 || p >= curve[i - 1][1])).toBe(true);
  });
});
