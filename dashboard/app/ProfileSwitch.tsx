"use client";

import { ACTS } from "@/lib/acts";
import { useProfile } from "./providers";

/** The act every screen reads: the fund (Act 1) or the loan (Act 2). */
export function ProfileSwitch() {
  const { profile, setProfile } = useProfile();
  return (
    <div className="pf-switch" role="radiogroup" aria-label="Act">
      {ACTS.map((o) => (
        <button
          key={o.profile}
          type="button"
          role="radio"
          aria-checked={profile === o.profile}
          className={`pf-opt ${profile === o.profile ? "pf-on" : ""}`}
          onClick={() => setProfile(o.profile)}
          title={o.doc}
        >
          <span className="pf-act">Act {o.act}</span>
          <span className="pf-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
