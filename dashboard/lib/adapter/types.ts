import type { AuditEvent, Party, PolicyData, ProfileId, ProfileSummary, Tri } from "../types";

/**
 * Everything a screen reads or changes. The static source serves exported JSON and mock parties; the
 * gateway source maps the same calls onto the operator API of PRD §7.8.
 */
export interface DataSource {
  kind: "static" | "gateway";
  profiles(): Promise<ProfileSummary[]>;
  policy(profile: ProfileId): Promise<PolicyData>;
  parties(profile: ProfileId): Promise<Party[]>;
  audit(profile: ProfileId): Promise<AuditEvent[]>;
  attest(profile: ProfileId, partyId: string, facts: Record<string, Tri>): Promise<Party>;
  resolve(profile: ProfileId, partyId: string, verdict: "approve" | "reject"): Promise<Party>;
  revoke(profile: ProfileId, partyId: string): Promise<Party>;
  /** Called after a mutation so every screen re-reads */
  subscribe(listener: () => void): () => void;
}
