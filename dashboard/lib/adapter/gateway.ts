// The operator gateway (PRD §7.8). Same calls as the static source; responses are expected in the
// exported shapes. Untested until the gateway routes exist — the static source is the demo path.
import type { AuditEvent, Deployment, Party, PolicyData, ProfileId, ProfileSummary, Tri } from "../types";
import type { DataSource } from "./types";

export function gatewaySource(baseUrl: string, apiKey = process.env.NEXT_PUBLIC_GATEWAY_KEY): DataSource {
  const listeners = new Set<() => void>();
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(init.method && init.method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const mutate = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const result = await call<T>(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    listeners.forEach((listener) => listener());
    return result;
  };
  const q = (profile: ProfileId) => `?profile=${encodeURIComponent(profile)}`;
  return {
    kind: "gateway",
    profiles: () => call<ProfileSummary[]>("/v1/policy/profiles"),
    policy: (profile) => call<PolicyData>(`/v1/policy${q(profile)}`),
    parties: (profile) => call<Party[]>(`/v1/lenders${q(profile)}`),
    audit: (profile) => call<AuditEvent[]>(`/v1/audit${q(profile)}`),
    deployment: async () => (await call<{ deployment?: Deployment }>("/v1/stack")).deployment ?? null,
    attest: (profile, id, facts: Record<string, Tri>) =>
      mutate<Party>(`/v1/lenders/${id}/attestations${q(profile)}`, "PATCH", { facts }),
    resolve: (profile, id, verdict) => mutate<Party>(`/v1/lenders/${id}/${verdict}${q(profile)}`, "POST"),
    revoke: (profile, id) => mutate<Party>(`/v1/lenders/${id}/revoke${q(profile)}`, "POST"),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
