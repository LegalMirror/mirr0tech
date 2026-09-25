"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { source } from "@/lib/adapter";
import { useResource, type Resource } from "@/lib/hooks";
import type { PolicyData, ProfileId } from "@/lib/types";

const KEY = "mirrortech.profile";
const PROFILES: ProfileId[] = ["custodial-rwa", "wildcat-credit"];

type ProfileState = { profile: ProfileId; setProfile: (profile: ProfileId) => void };
const ProfileContext = createContext<ProfileState | null>(null);

export function useProfile(): ProfileState {
  const state = useContext(ProfileContext);
  if (!state) throw new Error("useProfile outside Providers");
  return state;
}

/** The compiled policy of the selected profile. */
export function usePolicy(): Resource<PolicyData> {
  const { profile } = useProfile();
  return useResource(() => source.policy(profile), [profile]);
}

/** The credit bundle (three documents, terms) opens by default; the choice is remembered. */
export function Providers({ children }: { children: ReactNode }) {
  const [profile, set] = useState<ProfileId>("wildcat-credit");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as ProfileId | null;
      if (saved && PROFILES.includes(saved)) set(saved);
    } catch {
      /* storage refused — keep the default */
    }
  }, []);
  const setProfile = useCallback((next: ProfileId) => {
    set(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* not remembered next visit */
    }
  }, []);
  return <ProfileContext.Provider value={{ profile, setProfile }}>{children}</ProfileContext.Provider>;
}
