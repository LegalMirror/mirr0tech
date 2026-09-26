import { BASE } from "./base";
import { getSession } from "./session";

export type LedgerClause = { clauseId: number; ruleId: string; action: string | null; effect: string | null; clause: string | null; quote: string | null };
export type Ledger = {
  source: "multibaas";
  url: string;
  chainId: number;
  agreement: string;
  policyHash: string;
  fetchedAt: string;
  cached?: boolean;
  contracts: { alias: string; label: string; address: string }[];
  boundaries: {
    hook: string;
    token: string;
    poolId: string;
    poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
    callbacks: Record<string, boolean>;
    transferClauses: LedgerClause[];
  };
  decisions: {
    at: string;
    tx: string | null;
    subject: string;
    action: string;
    /** Where it was decided: the hook on chain, or a venue call the gateway refused before a transaction existed. */
    venue?: string;
    source?: "multibaas" | "gateway";
    allowed: boolean;
    clauseId: number;
    clause: LedgerClause | null;
  }[];
  byClause: { clauseId: number | null; ruleId: string | null; allowed: number; refused: number }[];
  attestations: { at: string; tx: string; subject: string; known: string; value: string; expiresAt: number }[];
  supply: { minted: string; burned: string };
  quota?: { calls: number; reads: number; cacheHits: number; perRefresh: number; cacheMs: number; since: string };
  /** A committed copy read when no gateway answers. */
  snapshot?: boolean;
};

/** The indexed policy ledger: public, read-only, cached by the gateway; the committed snapshot when no gateway answers. */
export async function fetchLedger(): Promise<Ledger> {
  let reason: string;
  try {
    const response = await fetch(`${getSession().url}/v1/indexed/ledger`, { cache: "no-store" });
    if (response.ok) return response.json();
    reason = response.status === 404 ? "This gateway has no MultiBaas ledger configured." : `Ledger unavailable (${response.status})`;
  } catch {
    reason = "The gateway did not answer.";
  }
  const snapshot = await fetch(`${BASE}/ledger.json`, { cache: "no-store" }).catch(() => null);
  if (snapshot?.ok) return { ...(await snapshot.json()), snapshot: true };
  throw new Error(reason);
}

/** Six-decimal share amounts, as the token stores them. */
export const shares = (raw: string) => (Number(BigInt(raw || "0")) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
