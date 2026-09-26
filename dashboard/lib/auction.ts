// The tender offer's price path: the bid opens at the floor and improves geometrically to the
// ceiling over the window, exactly as DutchAuctionBalanceOut decays the maker's balance out.

/** Price after `hours` since the offer opened, clamped to the window. */
export function auctionPrice(floor: number, ceiling: number, windowHours: number, hours: number): number {
  const t = Math.min(Math.max(hours / windowHours, 0), 1);
  return floor * Math.pow(ceiling / floor, t);
}

/** Sample points for a chart: [hours, price], from open to close. */
export function auctionCurve(
  floor: number,
  ceiling: number,
  windowHours: number,
  points = 25
): [number, number][] {
  return Array.from({ length: points }, (_, i) => {
    const hours = (windowHours * i) / (points - 1);
    return [hours, auctionPrice(floor, ceiling, windowHours, hours)];
  });
}
