// Compiles both profiles in-process through the real export, once per test file.
import type { PolicyData, ProfileId } from "@/lib/types";
// Plain ESM from the repository root; types are inferred from the JavaScript.
import { exportProfile, PROFILES } from "../../scripts/export-ui.js";

const cache = new Map<string, Promise<PolicyData>>();

export function compiled(profile: ProfileId): Promise<PolicyData> {
  if (!cache.has(profile)) {
    const spec = (PROFILES as { profile: string }[]).find((entry) => entry.profile === profile);
    cache.set(profile, exportProfile(spec) as Promise<PolicyData>);
  }
  return cache.get(profile)!;
}
