import type { IDKitDebugReport } from "@worldcoin/idkit";

const label = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
export function safeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid-url";
  }
}

/** IDKit reports can contain decrypted proofs and signed request material. Never log them raw. */
export function worldDebugSummary(report?: IDKitDebugReport) {
  return {
    available: !!report,
    sdkVersion: label(report?.package_version),
    transport: label(report?.transport),
    requestId: label(report?.request_id),
    generatedAt: label(report?.generated_at),
    requestCreated: !!report?.request_payload,
    responseReceived: !!report?.response_payload,
    appError: appError(report?.response_payload),
  };
}

/** The World App's own reason for a refused request. Only error fields are kept, never proof material. */
function appError(payload: unknown): Record<string, string> | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || "responses" in value || "proof" in value) return undefined;
  const picked = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, field]) => /error|code|reason|message|detail|status/i.test(key) && typeof field === "string")
      .map(([key, field]) => [key, (field as string).slice(0, 200)])
  );
  return Object.keys(picked).length ? picked : undefined;
}

/** Observe only World transport and WASM fetches while the login widget is mounted. */
export function observeWorldTransport() {
  const original = window.fetch;
  const events: Record<string, unknown>[] = [];
  const observed: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    const wasm = url.pathname.endsWith(".wasm");
    const world = /(^|\.)(world\.org|worldcoin\.org|worldcoin\.dev)$/.test(url.hostname);
    if (!world && !wasm) return original.call(window, input, init);
    const started = performance.now();
    const record: Record<string, unknown> = {
      target: url.origin, // No query, fragment, user info, bridge request ID, or encryption key.
      kind: wasm ? "wasm" : "world-transport",
      method: init?.method || (input instanceof Request ? input.method : "GET"),
      startedAt: new Date().toISOString(),
    };
    const log = () => {
      record.durationMs = Math.round(performance.now() - started);
      events.push(record);
      if (events.length > 20) events.shift();
      console.info("[World ID] transport", record);
    };
    try {
      const response = await original.call(window, input, init);
      record.status = response.status;
      record.ok = response.ok;
      log();
      return response;
    } catch (error) {
      record.errorName = error instanceof Error ? label(error.name) : "unknown";
      record.browserOnline = navigator.onLine;
      log();
      throw error;
    }
  };
  window.fetch = observed;
  return {
    events,
    stop: () => {
      if (window.fetch === observed) window.fetch = original;
    },
  };
}
