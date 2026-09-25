"use client";

import { source } from "@/lib/adapter";
import { useResource } from "@/lib/hooks";
import { useProfile, usePolicy } from "../providers";

/** The selected profile's policy and its parties, loaded together. */
export function usePolicyAndParties() {
  const { profile } = useProfile();
  const policy = usePolicy();
  const parties = useResource(() => source.parties(profile), [profile]);
  return { profile, policy, parties };
}
