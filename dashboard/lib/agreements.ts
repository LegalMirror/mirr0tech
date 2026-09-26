import type { Coverage, PolicyData, ProfileId, Verification, WorldIdContext } from "./types";
import { gatewayRequest, type GatewaySession } from "./session";

export type AgreementStatus =
  "uploaded" | "extracting" | "verified" | "compiled" | "deploying" | "deployed" | "failed";
export type AgreementDeployment = {
  chainId: number;
  policyHash: string;
  oracle: string;
  token: string;
  hook: string;
  poolManager: string;
  poolId: string;
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
  extraction: { provider: string; model: string | null; responseId?: string; agents?: string[] } | null;
  verification: { confidence: Omit<Verification["confidence"], "byRef">; contested: number } | null;
  policyHash: string | null;
  clauseTableHash: string | null;
  coverage: Omit<Coverage, "paragraphs"> | null;
  deployment: AgreementDeployment | null;
  error: string | null;
  history: { status: AgreementStatus; at: string; policyHash?: string }[];
};
export type AgreementDetail = Agreement & { export: PolicyData | null };
export type StackStatus = {
  model: { provider: string; mode: "mock" | "live" | "unavailable"; url?: string; model?: string };
  compiler: { solidity: Record<string, string> };
  chain: { chainId: number; deployer?: string; attestor?: string; poolManager?: string } | null;
};
export type AstNode = {
  id: string;
  kind: "agreement" | "action" | "rule" | "fact" | "term" | "unresolved";
  label: string;
  effect?: string;
  clauseId?: number;
  clause?: string;
  value?: string;
  status?: string;
  confidence?: number | null;
  description?: string;
};
export type AstGraph = { nodes: AstNode[]; edges: { from: string; to: string }[] };
export type IdentityConstraint = {
  credential: "document" | "proof_of_human" | "selfie";
  actions: string[];
  clause: string;
  quote: string;
};
export type Constraints = { identity: IdentityConstraint | null };
export type Upload = {
  name: string;
  profile: ProfileId;
  documents: { name: string; text: string }[];
  config?: Record<string, unknown>;
};
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
  !!status && ["verified", "compiled", "deployed", "failed"].includes(status);
export function deployBlocked(
  record: Agreement | null,
  status: StackStatus | null,
  writable: boolean
): string | null {
  if (!writable) return "Start an active demo workspace to deploy your own agreement.";
  if (!record || record.status !== "compiled") return "Deployment requires a compiled agreement.";
  if (record.profile === "wildcat-credit")
    return "This credit profile uses the existing stack venue; per-agreement deployment is not supported.";
  if (!status?.chain) return "No chain signer is reported by this gateway.";
  return null;
}

export function validateUpload(upload: Upload): void {
  if (!upload.name.trim()) throw new Error("Give this agreement a name.");
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
