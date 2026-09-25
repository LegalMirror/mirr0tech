"use client";

import type { ProfileId } from "@/lib/types";
import { useProfile } from "./providers";

const OPTIONS: { profile: ProfileId; act: string; label: string; doc: string }[] = [
  {
    profile: "custodial-rwa",
    act: "Act 1",
    label: "Tokenize & trade",
    doc: "Securitize transfer-agent agreement",
  },
  {
    profile: "wildcat-credit",
    act: "Act 2",
    label: "Lend it out",
    doc: "Wildcat MLA + Lender Check Policy + addendum",
  },
];

/** One compiler, two documents: the switch every screen reads. */
export function ProfileSwitch() {
  const { profile, setProfile } = useProfile();
  return (
    <div className="pf-switch" role="radiogroup" aria-label="Policy">
      {OPTIONS.map((o) => (
        <button
          key={o.profile}
          type="button"
          role="radio"
          aria-checked={profile === o.profile}
          className={`pf-opt ${profile === o.profile ? "pf-on" : ""}`}
          onClick={() => setProfile(o.profile)}
          title={o.doc}
        >
          <span className="pf-act">{o.act}</span>
          <span className="pf-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
