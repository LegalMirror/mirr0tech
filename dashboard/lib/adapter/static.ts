// Serves the JSON written by `npm run ui:export` and keeps mock parties in memory, so the queue and
// the lender list stay consistent for the length of a session.
import type { AuditEvent, Party, PolicyData, ProfileId, ProfileSummary, Tri } from "../types";
import { mockAudit, mockParties } from "./mock";
import type { DataSource } from "./types";

const policies = new Map<ProfileId, Promise<PolicyData>>();
const parties = new Map<ProfileId, Party[]>();
const listeners = new Set<() => void>();

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`${path}: ${response.status}. Run \`npm run ui:export\` from the repository root.`);
  return (await response.json()) as T;
}

function partiesOf(profile: ProfileId): Party[] {
  if (!parties.has(profile)) parties.set(profile, mockParties(profile));
  return parties.get(profile)!;
}

function update(profile: ProfileId, id: string, change: (party: Party) => void): Party {
  const party = partiesOf(profile).find((entry) => entry.id === id);
  if (!party) throw new Error(`Unknown party ${id}`);
  change(party);
  listeners.forEach((listener) => listener());
  return structuredClone(party);
}

export const staticSource: DataSource = {
  kind: "static",
  profiles: async () => (await json<{ profiles: ProfileSummary[] }>("/data/index.json")).profiles,
  policy(profile) {
    if (!policies.has(profile)) {
      const load = json<PolicyData>(`/data/${profile}.json`);
      load.catch(() => policies.delete(profile));
      policies.set(profile, load);
    }
    return policies.get(profile)!;
  },
  parties: async (profile) => structuredClone(partiesOf(profile)),
  audit: async (profile): Promise<AuditEvent[]> => mockAudit(profile),
  attest: async (profile, id, facts: Record<string, Tri>) =>
    update(profile, id, (party) => {
      Object.assign(party.facts, facts);
      party.screenedAt ??= Math.floor(Date.now() / 1000);
      delete party.resolution;
    }),
  resolve: async (profile, id, verdict) =>
    update(profile, id, (party) => {
      party.resolution = verdict === "approve" ? "approved" : "rejected";
    }),
  revoke: async (profile, id) =>
    update(profile, id, (party) => {
      party.screenedAt = null;
      delete party.resolution;
    }),
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
