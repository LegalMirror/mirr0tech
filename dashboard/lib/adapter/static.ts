// Serves the JSON written by `npm run ui:export` and keeps mock parties in memory, so the queue and
// the lender list stay consistent for the length of a session.
import type { AuditEvent, Deployment, Party, PolicyData, ProfileId, ProfileSummary, Tri } from "../types";
import { mockAudit, mockParties } from "./mock";
import type { DataSource } from "./types";
import { BASE } from "../base";

const policies = new Map<ProfileId, Promise<PolicyData>>();
const parties = new Map<ProfileId, Party[]>();
const listeners = new Set<() => void>();

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`${path}: ${response.status}. Run \`npm run ui:export\` from the repository root.`);
  return (await response.json()) as T;
}

/** The exported snapshot (a Sepolia run) when the build has one, mock parties otherwise; kept in memory after that. */
async function partiesOf(profile: ProfileId): Promise<Party[]> {
  if (!parties.has(profile)) {
    let loaded: Party[] | null = null;
    try {
      const response = await fetch(`${BASE}/data/parties-${profile}.json`);
      if (response.ok) loaded = (await response.json()) as Party[];
    } catch {
      loaded = null;
    }
    parties.set(profile, loaded ?? mockParties(profile));
  }
  return parties.get(profile)!;
}

async function update(profile: ProfileId, id: string, change: (party: Party) => void): Promise<Party> {
  const party = (await partiesOf(profile)).find((entry) => entry.id === id);
  if (!party) throw new Error(`Unknown party ${id}`);
  change(party);
  listeners.forEach((listener) => listener());
  return structuredClone(party);
}

export const staticSource: DataSource = {
  kind: "static",
  profiles: async () => (await json<{ profiles: ProfileSummary[] }>(`${BASE}/data/index.json`)).profiles,
  policy(profile) {
    if (!policies.has(profile)) {
      const load = json<PolicyData>(`${BASE}/data/${profile}.json`);
      load.catch(() => policies.delete(profile));
      policies.set(profile, load);
    }
    return policies.get(profile)!;
  },
  parties: async (profile) => structuredClone(await partiesOf(profile)),
  audit: async (profile): Promise<AuditEvent[]> => {
    const response = await fetch(`${BASE}/data/audit-${profile}.json`);
    return response.ok ? ((await response.json()) as AuditEvent[]) : mockAudit(profile);
  },
  deployment: async () => {
    const response = await fetch(`${BASE}/data/deployment.json`);
    return response.ok ? ((await response.json()) as Deployment) : null;
  },
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
