// The two acts the screens show. The compiler also builds a custody-only reading of the fund
// agreement (custodial-rwa); it stays in the exports and tests but has no tab of its own.
import type { ProfileId } from "./types";

export const ACTS: { profile: ProfileId; act: number; label: string; doc: string }[] = [
  {
    profile: "rwa-secondary",
    act: 1,
    label: "Fund",
    doc: "Securitize transfer-agent contract, with the transfer rules the Uniswap v4 hook enforces",
  },
  { profile: "wildcat-credit", act: 2, label: "Loan", doc: "Wildcat MLA + Lender Check Policy + addendum" },
];
export const VISIBLE_PROFILES: ProfileId[] = ACTS.map((entry) => entry.profile);

/** The tab a profile belongs to: the custody-only reading shows under the fund act. */
export const visibleProfile = (profile: ProfileId): ProfileId =>
  profile === "custodial-rwa" ? "rwa-secondary" : profile;
