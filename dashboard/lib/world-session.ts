import { safeOrigin } from "./world-diagnostics";

export type WorldAccount = {
  id: string;
  provider: "world-id" | "world-id-mock";
  environment: "sandbox" | "staging" | "production" | "mock";
  mock: boolean;
  credential: "proof_of_human" | "selfie" | "orb" | null;
  passportVerified: false;
};
export type WorldSession = { account: WorldAccount; expiresAt: number };
const KEY = "mirr0tech.world-session";
let current: { url: string; accessToken: string } | null = null;

export function worldSessionHeaders(url: string): Record<string, string> {
  return current?.url === url ? { "X-World-Session": current.accessToken } : {};
}
export function restoreWorldToken(url: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    current = saved?.url === url && /^world_[a-f0-9]{64}$/.test(saved?.accessToken) ? saved : null;
  } catch {
    current = null;
  }
  return !!current;
}
export function saveWorldToken(url: string, accessToken: string) {
  current = { url, accessToken };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Memory-only if storage is blocked. */
  }
}
export function clearWorldToken() {
  current = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Storage may be blocked. */
  }
}
export function worldSessionRejected() {
  clearWorldToken();
  window.dispatchEvent(new Event("world-session-expired"));
}
export async function worldRequest<T>(url: string, path: string, body?: unknown): Promise<T> {
  const started = Date.now();
  const details: Record<string, unknown> = {
    gateway: safeOrigin(url),
    endpoint: path,
    method: body === undefined ? "GET" : "POST",
  };
  try {
    const response = await fetch(`${url}/v1/auth/world/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...worldSessionHeaders(url),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    details.status = response.status;
    details.requestId = response.headers.get("X-World-Request-ID");
    const value = await response.json();
    if (!response.ok) {
      const code = value?.error?.code;
      details.code = typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "HTTP_ERROR";
      // The backend's message names the failing checks or World's refusal code; it carries no proof material.
      const message = value?.error?.message;
      if (typeof message === "string") details.message = message.slice(0, 400);
      if (response.status === 401) worldSessionRejected();
      throw new Error(value?.error?.message || "World ID login is unavailable. Please try again.");
    }
    console.info("[World ID] API request completed", { ...details, durationMs: Date.now() - started });
    return value as T;
  } catch (error) {
    console.error("[World ID] API request failed", {
      ...details,
      durationMs: Date.now() - started,
      errorName: error instanceof Error ? error.name : "unknown",
      browserOnline: typeof navigator === "undefined" ? undefined : navigator.onLine,
    });
    throw error;
  }
}
