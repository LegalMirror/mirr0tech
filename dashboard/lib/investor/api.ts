import type {
  Confirmation,
  InvestorActivity,
  InvestorChallenge,
  InvestorConfig,
  InvestorSession,
  PreparedIntent,
  PublicFund,
  Snapshot,
  TradeInput,
  TransactionRequest,
  InvestorQuote,
  IdentityResult,
} from "./types";
import { INVESTOR_API } from "./types";
import { sessionAlive } from "./session";

export class InvestorApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = "InvestorApiError";
  }
}

export function investorClient(baseUrl = INVESTOR_API) {
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  )
    throw new Error("The investor gateway must use HTTPS (or local HTTP), without credentials in its URL.");
  async function request<T>(
    path: string,
    session: InvestorSession | null,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (session && !sessionAlive(session))
      throw new InvestorApiError(
        "Your investor session expired. Sign in again; no transaction was submitted by this request.",
        401,
        "SESSION_EXPIRED"
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/investor${path}`, {
        method,
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        const pending = !session && method === "GET" && [401, 403, 404, 405, 501].includes(response.status);
        throw new InvestorApiError(
          pending
            ? "The public investor API is not available on this gateway yet. The issuer workbench can remain online while the investor backend is being updated. Retry later; an operator key is not required here."
            : (value?.error?.message ?? `${method} investor${path}: ${response.status}`),
          response.status,
          value?.error?.code ?? (pending ? "BACKEND_PENDING" : "HTTP_ERROR")
        );
      }
      if (value === null)
        throw new InvestorApiError(
          "The investor API returned an empty or outdated response. Refresh after the backend update.",
          502,
          "INVALID_RESPONSE"
        );
      return value as T;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted)
        throw new InvestorApiError(
          "The investor gateway timed out. A submitted identity or confirmation request may still be processing; refresh rather than replaying it.",
          0,
          "TIMEOUT"
        );
      if (error instanceof TypeError)
        throw new InvestorApiError(
          "Cannot reach the investor gateway. Check network access and the gateway's allowed dashboard origin (CORS).",
          0,
          "NETWORK"
        );
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return {
    config: async (signal?: AbortSignal) => {
      const result = await request<InvestorConfig>("/config", null, "GET", undefined, signal);
      if (
        !(result.chainId === null || Number.isSafeInteger(result.chainId)) ||
        !(result.environment === null || typeof result.environment === "string") ||
        !(
          result.credential === null || ["document", "proof_of_human", "selfie"].includes(result.credential)
        ) ||
        typeof result.mock !== "boolean"
      )
        throw new Error("Investor configuration is incomplete. The public API may need an update.");
      return result;
    },
    funds: async (signal?: AbortSignal) => {
      const result = await request<PublicFund[]>("/funds", null, "GET", undefined, signal);
      if (
        !Array.isArray(result) ||
        result.some(
          (fund) =>
            !fund.id || !fund.name || !Number.isSafeInteger(fund.chainId) || typeof fund.cashier !== "boolean"
        )
      )
        throw new Error(
          "The public fund list has an unsupported shape. Ask the gateway operator to update the investor API."
        );
      return result;
    },
    challenge: (wallet: string, fundId: string, signal?: AbortSignal) =>
      request<InvestorChallenge>("/auth/challenge", null, "POST", { wallet, fundId }, signal),
    verify: (challengeId: string, signature: string, proof: unknown, signal?: AbortSignal) =>
      request<InvestorSession>("/auth/verify", null, "POST", { challengeId, signature, proof }, signal),
    me: (session: InvestorSession, signal?: AbortSignal) =>
      request<Snapshot>("/me", session, "GET", undefined, signal),
    activity: (session: InvestorSession, signal?: AbortSignal) =>
      request<InvestorActivity>("/activity", session, "GET", undefined, signal),
    identity: (session: InvestorSession, signal?: AbortSignal) =>
      request<IdentityResult>("/identity", session, "POST", {}, signal),
    quote: (session: InvestorSession, body: TradeInput, signal?: AbortSignal) =>
      request<InvestorQuote>("/quote", session, "POST", body, signal),
    prepare: (session: InvestorSession, body: TransactionRequest, signal?: AbortSignal) =>
      request<PreparedIntent>("/transactions/prepare", session, "POST", body, signal),
    confirm: (session: InvestorSession, intentId: string, txHash: string, signal?: AbortSignal) =>
      request<Confirmation>("/transactions/confirm", session, "POST", { intentId, txHash }, signal),
  };
}
export type InvestorClient = ReturnType<typeof investorClient>;
