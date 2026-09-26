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
  decisions: { at: string; tx: string; subject: string; action: string; allowed: boolean; clauseId: number; clause: LedgerClause | null }[];
  byClause: { clauseId: number | null; ruleId: string | null; allowed: number; refused: number }[];
  attestations: { at: string; tx: string; subject: string; known: string; value: string; expiresAt: number }[];
  supply: { minted: string; burned: string };
};

/** The indexed policy ledger: public, read-only, cached by the gateway. */
export async function fetchLedger(): Promise<Ledger> {
  const response = await fetch(`${getSession().url}/v1/indexed/ledger`, { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "This gateway has no MultiBaas ledger configured." : `Ledger unavailable (${response.status})`);
  return response.json();
}

/** Six-decimal share amounts, as the token stores them. */
export const shares = (raw: string) => (Number(BigInt(raw || "0")) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
