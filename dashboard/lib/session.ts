// Credentials live only in this module's memory. Never put an operator key in a public env var,
// URL, localStorage, sessionStorage, or a generated file.
export type GatewaySession = { url: string; viewerKey: string; operatorKey: string; revision: number };
const initial: GatewaySession = {
  url: process.env.NEXT_PUBLIC_GATEWAY_URL?.replace(/\/$/, "") ?? "",
  viewerKey: "",
  operatorKey: "",
  revision: 0,
};
let session = initial;
const listeners = new Set<() => void>();
export const getSession = () => session;
export const getServerSession = () => initial;
export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function gatewayUrl(value: string): string {
  if (!value.trim()) return "";
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Use a gateway URL without credentials, query parameters, or a fragment.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Use HTTPS for a remote gateway. HTTP is allowed only on localhost.");
  return url.toString().replace(/\/$/, "");
}

export function setSession(next: Omit<GatewaySession, "revision">) {
  session = { ...next, url: gatewayUrl(next.url), revision: session.revision + 1 };
  listeners.forEach((listener) => listener());
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export async function gatewayRequest<T>(
  connection: GatewaySession,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const method = init.method ?? "GET";
  const write = !["GET", "HEAD"].includes(method);
  if (!connection.url) throw new Error("Connect a gateway first. Samples are read-only.");
  if (write && !connection.operatorKey)
    throw new Error("An operator key is required for this action. Add it in Connection; it stays in memory.");
  const key = write ? connection.operatorKey : connection.viewerKey || connection.operatorKey;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  try {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (key) headers.set("authorization", `Bearer ${key}`);
    if (write) headers.set("idempotency-key", crypto.randomUUID());
    const response = await fetch(`${connection.url.replace(/\/$/, "")}${path}`, {
      ...init,
      method,
      headers,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new GatewayError(
        body?.error?.message ?? `${method} ${path}: ${response.status}`,
        response.status,
        body?.error?.code ?? "HTTP_ERROR"
      );
    if (body === null) throw new Error("The gateway returned an empty or invalid JSON response.");
    return body as T;
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted)
      throw new Error(
        "The gateway did not respond within 30 seconds. The operation may still be running; refresh before retrying a write."
      );
    if (error instanceof TypeError)
      throw new Error(
        "Could not reach the gateway. Check its URL, network access, and CORS allowed origin for this dashboard."
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}
