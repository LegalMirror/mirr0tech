import type { LegalAst, LegalNode, LegalSource } from "./legal-ast";
import type { Coverage, PolicyData, ProfileId, Verification, WorldIdContext } from "./types";
import { gatewayRequest, type GatewaySession } from "./session";
import type { SwapQuote, SwapApprovals, SwapTransaction, SwapState } from "./swap";

export type AgreementStatus =
  "uploaded" | "extracting" | "verified" | "analyzed" | "compiled" | "deploying" | "deployed" | "failed";
export type AgreementDeployment = {
  chainId: number;
  policyHash: string;
  oracle: string;
  token: string;
  asset?: string;
  cashier?: { enabled: boolean; [key: string]: unknown };
  hook?: string;
  poolManager?: string;
  poolId?: string;
  poolKey?: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  roleProvider?: string;
  market?: string;
  router?: string;
  routing?: "uniswap-api";
  positionManager?: string;
  permit2?: string;
  quoter?: string;
  mockMarket?: boolean;
  deployedAt: string;
  txs: Record<string, string>;
};
export type Agreement = {
  id: string;
  name: string;
  profile: ProfileId;
  status: AgreementStatus;
  createdAt: string;
  updatedAt: string;
  source: { name: string; sha256: string; textSha256: string };
  extraction: {
    provider: string;
    model: string | null;
    responseId?: string;
    reasoningEffort?: string;
    analysisMode?: "light";
    compilerMapping?: { provider: string; id: string; scope: string };
    agents?: string[];
  } | null;
  verification: { confidence: Omit<Verification["confidence"], "byRef">; contested: number } | null;
  policyHash: string | null;
  clauseTableHash: string | null;
  coverage: Omit<Coverage, "paragraphs"> | null;
  deployment: AgreementDeployment | null;
  error: string | null;
  /** While a live deliberation runs: percent done and the confidence so far. */
  progress?: { job: string; percent: number | null; confidence: number | null; at: string } | null;
  history: { status: AgreementStatus; at: string; policyHash?: string }[];
};
export type AgreementDetail = Agreement & {
  mintOperations?: MintOperation[];
  seedOperations?: SeedOperation[];
  export: PolicyData | null;
  documentAst?: LegalAst | null;
  ast?:
    | LegalAst
    | {
        title: string;
        rules: { id: string; action: string; source: { clause: string; quote: string }; rationale: string }[];
        unresolved: { clause: string; description: string }[];
      }
    | null;
};
export type LiquidityState = {
  backend: string;
  token: string;
  asset: string;
  poolId: string;
  liquidity: string;
  rwaBalance: string;
  usdBalance: string;
};
export type SeedOperation = {
  requestId: string;
  rwaAmount: string;
  usdAmount: string;
  poolId: string;
  backend?: string;
  status: "pending" | "confirmed" | "failed";
  stage: string;
  approvalTxHash?: string;
  approvalTxHashes?: string[];
  seedTxHash?: string;
  error?: string | null;
};
export type MintOperation = {
  bypassSubscription?: boolean;
  simulateDeposit?: boolean;
  testAttestations?: Record<string, boolean>;
  subscriptionTxHash?: string | null;
  depositTxHash?: string | null;
  issuerAuthorizedTxHash?: string | null;
  offeringCompliantTxHash?: string | null;
  identityVerifiedTxHash?: string | null;
  kycApprovedTxHash?: string | null;
  amlApprovedTxHash?: string | null;
  sanctionsClearTxHash?: string | null;
  requestId: string;
  recipient: string;
  amount: string;
  units: string;
  token: string;
  chainId: number;
  backend?: string;
  status: "pending" | "confirmed" | "failed";
  stage: "mint" | "release" | "complete";
  minted?: boolean;
  mintTxHash?: string | null;
  releaseTxHash?: string | null;
  error?: string | null;
};
export type StackStatus = {
  model: { provider: string; mode: "mock" | "live" | "unavailable"; url?: string; model?: string };
  compiler: { solidity: Record<string, string> };
  chain: { chainId: number; deployer?: string; attestor?: string; poolManager?: string } | null;
};
export type AstNode = {
  id: string;
  kind: "agreement" | "action" | "rule" | "fact" | "term" | "unresolved" | "document" | LegalNode["kind"];
  label: string;
  effect?: string;
  clauseId?: number;
  clause?: string;
  value?: string;
  status?: string;
  confidence?: number | null;
  description?: string;
  source?: LegalSource;
};
export type AstGraph = {
  nodes: AstNode[];
  edges: { from: string; to: string; kind?: string; source?: LegalSource }[];
};
export type IdentityConstraint = {
  credential: "document" | "proof_of_human" | "selfie";
  actions: string[];
  clause: string;
  quote: string;
};
export type Constraints = { identity: IdentityConstraint | null };
export type Upload = {
  generation?: "demo" | "openai" | "noolog";
  name: string;
  profile: ProfileId;
  documents: { name: string; text: string }[];
  config?: Record<string, unknown>;
};
/** Noolog when the gateway reads with it; otherwise a local workspace picks the fixture or OpenAI, a hosted one leaves it to the gateway. */
export function generationFor({
  provider,
  localWorkspace,
  mode,
}: {
  provider: string | undefined;
  localWorkspace: boolean;
  mode: "demo" | "files";
}): Upload["generation"] {
  if (provider === "noolog") return "noolog";
  if (localWorkspace) return mode === "demo" ? "demo" : "openai";
  return undefined;
}
export type AccessDecision = {
  wallet: string;
  address: string;
  action: string;
  allowed: boolean;
  clauseId: number;
  clause: { clause: string; quote: string } | null;
  facts: Record<string, boolean | null>;
  sanctioned: boolean;
  screeningCurrent: boolean;
};
export type IdentityReceipt = {
  type: string;
  status: string;
  txHash: string | null;
  wallet: string;
  facts?: { identityVerified?: boolean };
};
export type AgreementWallet = {
  name: string;
  address: string;
  rwa: { facts: Record<string, boolean | null> };
};

export function agreementsClient(session: GatewaySession) {
  const call = <T>(path: string, init?: RequestInit) => gatewayRequest<T>(session, path, init);
  const path = (id: string) => `/v1/agreements/${encodeURIComponent(id)}`;
  return {
    list: (signal?: AbortSignal) => call<Agreement[]>("/v1/agreements", { signal }),
    status: (signal?: AbortSignal) => call<StackStatus>("/v1/status", { signal }),
    get: (id: string, signal?: AbortSignal) => call<AgreementDetail>(path(id), { signal }),
    ast: (id: string, signal?: AbortSignal) => call<AstGraph>(`${path(id)}/ast`, { signal }),
    constraints: (id: string, signal?: AbortSignal) =>
      call<Constraints>(`${path(id)}/constraints`, { signal }),
    upload: (body: Upload) =>
      call<Agreement>("/v1/agreements", { method: "POST", body: JSON.stringify(body) }),
    constrain: (id: string, body: Constraints) =>
      call<Agreement>(`${path(id)}/constraints`, { method: "PUT", body: JSON.stringify(body) }),
    regenerate: (id: string) => call<Agreement>(`${path(id)}/regenerate`, { method: "POST" }),
    deploy: (id: string) => call<Agreement>(`${path(id)}/deploy`, { method: "POST" }),
    liquidity: (id: string, signal?: AbortSignal) =>
      call<LiquidityState>(`${path(id)}/liquidity`, { signal }),
    seed: (id: string, body: { rwaAmount: string; usdAmount: string; requestId: string }) =>
      call<SeedOperation>(`${path(id)}/liquidity/seeds`, { method: "POST", body: JSON.stringify(body) }),
    seedOperation: (id: string, requestId: string, signal?: AbortSignal) =>
      call<SeedOperation>(`${path(id)}/liquidity/seeds/${encodeURIComponent(requestId)}`, { signal }),
    mint: (
      id: string,
      body: {
        recipient: string;
        amount: string;
        requestId: string;
        bypassSubscription?: boolean;
        simulateDeposit?: boolean;
        testAttestations?: Record<string, boolean>;
      }
    ) => call<MintOperation>(`${path(id)}/mint`, { method: "POST", body: JSON.stringify(body) }),
    mintOperation: (id: string, requestId: string, signal?: AbortSignal) =>
      call<MintOperation>(`${path(id)}/mints/${encodeURIComponent(requestId)}`, { signal }),
    swapState: (id: string, wallet: string, signal?: AbortSignal) =>
      call<SwapState>(`${path(id)}/swap/state?wallet=${encodeURIComponent(wallet)}`, { signal }),
    swapReceipt: (id: string, hash: string) =>
      call<{ hash: string; status: number; blockNumber: number } | null>(
        `${path(id)}/swap/receipts/${encodeURIComponent(hash)}`
      ),
    swapQuote: (
      id: string,
      body: { wallet: string; direction: "buy" | "sell"; amount: string; slippageBps: number }
    ) => call<SwapQuote>(`${path(id)}/swap/quote`, { method: "POST", body: JSON.stringify(body) }),
    swapApproval: (id: string, body: { wallet: string; quoteId: string }) =>
      call<SwapApprovals>(`${path(id)}/swap/approval`, { method: "POST", body: JSON.stringify(body) }),
    swapTransaction: (id: string, body: { wallet: string; quoteId: string; signature?: string }) =>
      call<{ transaction: SwapTransaction; expiresAt: number }>(`${path(id)}/swap/transaction`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    wallets: (id: string, signal?: AbortSignal) =>
      call<AgreementWallet[]>(`${path(id)}/stack/wallets`, { signal }),
    wallet: (id: string, wallet: string, signal?: AbortSignal) =>
      call<AgreementWallet>(`${path(id)}/stack/wallets/${encodeURIComponent(wallet)}`, { signal }),
    explain: (id: string, wallet: string, action: string, signal?: AbortSignal) =>
      call<AccessDecision>(
        `${path(id)}/stack/wallets/${encodeURIComponent(wallet)}/explain?policy=rwa&action=${encodeURIComponent(action)}`,
        { signal }
      ),
    worldIdContext: (id: string, signal?: AbortSignal) =>
      call<WorldIdContext>(`${path(id)}/stack/worldid/context`, { signal }),
    verifyHuman: (id: string, wallet: string, proof: unknown) =>
      call<IdentityReceipt>(`${path(id)}/stack/wallets/${encodeURIComponent(wallet)}/worldid`, {
        method: "POST",
        body: JSON.stringify({ proof }),
      }),
  };
}
export type AgreementsClient = ReturnType<typeof agreementsClient>;
export const inFlight = (status?: AgreementStatus) =>
  !!status && ["uploaded", "extracting", "verified", "deploying"].includes(status);
export const canRegenerate = (status?: AgreementStatus) =>
  !!status && ["verified", "analyzed", "compiled", "deployed", "failed"].includes(status);
export function deployBlocked(
  record: Agreement | null,
  status: StackStatus | null,
  writable: boolean
): string | null {
  if (!writable) return "Start an active demo workspace to deploy your own contract.";
  if (!record || record.status !== "compiled") return "Deployment requires a compiled contract.";
  if (!status?.chain) return "No chain signer is reported by this gateway.";
  return null;
}

export function validateUpload(upload: Upload): void {
  if (!upload.name.trim()) throw new Error("Give this contract a name.");
  if (!upload.documents.length) throw new Error("Paste a document or choose at least one text file.");
  for (const doc of upload.documents) {
    if (!/\.(txt|md|htm|html)$/i.test(doc.name))
      throw new Error(`${doc.name}: use .txt, .md, .htm or .html. PDF is not supported.`);
    if (!doc.text.trim()) throw new Error(`${doc.name}: the document is empty.`);
    if (new TextEncoder().encode(doc.text).length > 2 * 1024 * 1024)
      throw new Error(`${doc.name}: each document must be at most 2 MB.`);
  }
  if (new TextEncoder().encode(JSON.stringify(upload)).length > 4 * 1024 * 1024)
    throw new Error("The encoded upload must be at most 4 MB. Upload a smaller bundle.");
}

/** Serial, cancellable polling. A slow request never overlaps the next, and errors remain retryable. */
export function poll<T>(
  read: (signal: AbortSignal) => Promise<T>,
  receive: (data: T) => void,
  fail: (error: Error) => void,
  delay: (data: T) => number
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    let wait = 5000;
    try {
      const data = await read(controller.signal);
      if (controller.signal.aborted) return;
      receive(data);
      wait = delay(data);
    } catch (error) {
      if (controller.signal.aborted) return;
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    if (!controller.signal.aborted) timer = setTimeout(tick, wait);
  };
  void tick();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

/** True once, when a mint or seed operation first reaches confirmed; views then re-read the balances they show. */
export function operationSettled(
  previous: { status: string } | null | undefined,
  next: { status: string }
): boolean {
  return next.status === "confirmed" && previous?.status !== "confirmed";
}

/** Short label for the stage a pending mint or seed operation is waiting on. */
export function operationLabel(stage: string): string {
  const labels: Record<string, string> = {
    approval: "Approving tokens…",
    mint: "Minting…",
    release: "Releasing tokens…",
    seed: "Seeding pool…",
  };
  return labels[stage] ?? "Waiting for confirmation…";
}
