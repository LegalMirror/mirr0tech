import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agreementsClient,
  canRegenerate,
  deployBlocked,
  inFlight,
  poll,
  validateUpload,
  type Agreement,
  type StackStatus,
  type Upload,
} from "@/lib/agreements";

const session = { url: "https://gateway.example", viewerKey: "viewer", operatorKey: "operator", revision: 0 };
const upload: Upload = {
  name: "Fund",
  profile: "rwa-secondary",
  documents: [{ name: "fund.md", text: "# Fund\nOnly approved investors may transfer." }],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("agreements client matches the existing REST contract", () => {
  it("maps upload, export, AST, constraints, regenerate, deploy and World ID to agreement-scoped routes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}");
      })
    );
    const client = agreementsClient(session);
    await client.status();
    await client.list();
    await client.upload(upload);
    await client.get("agr_a");
    await client.ast("agr_a");
    await client.constraints("agr_a");
    await client.constrain("agr_a", {
      identity: {
        credential: "document",
        actions: ["mint"],
        clause: "1",
        quote: "Only approved investors may transfer.",
      },
    });
    await client.constrain("agr_a", { identity: null });
    await client.regenerate("agr_a");
    await client.deploy("agr_a");
    await client.wallets("agr_a");
    await client.worldIdContext("agr_a");
    await client.verifyHuman("agr_a", "Investor / 1", { proof: "test" });
    await client.wallet("agr_a", "Investor / 1");
    await client.explain("agr_a", "Investor / 1", "mint");
    expect(calls.map(({ url, init }) => `${init.method} ${url.replace(session.url, "")}`)).toEqual([
      "GET /v1/status",
      "GET /v1/agreements",
      "POST /v1/agreements",
      "GET /v1/agreements/agr_a",
      "GET /v1/agreements/agr_a/ast",
      "GET /v1/agreements/agr_a/constraints",
      "PUT /v1/agreements/agr_a/constraints",
      "PUT /v1/agreements/agr_a/constraints",
      "POST /v1/agreements/agr_a/regenerate",
      "POST /v1/agreements/agr_a/deploy",
      "GET /v1/agreements/agr_a/stack/wallets",
      "GET /v1/agreements/agr_a/stack/worldid/context",
      "POST /v1/agreements/agr_a/stack/wallets/Investor%20%2F%201/worldid",
      "GET /v1/agreements/agr_a/stack/wallets/Investor%20%2F%201",
      "GET /v1/agreements/agr_a/stack/wallets/Investor%20%2F%201/explain?policy=rwa&action=mint",
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual(upload);
    expect(JSON.parse(String(calls[7].init.body))).toEqual({ identity: null });
    expect(calls[9].init.body).toBeUndefined();
    expect(JSON.parse(String(calls[12].init.body))).toEqual({ proof: { proof: "test" } });
  });
  it.each([401, 409, 413, 503])("does not swallow HTTP %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "TEST", message: "Gateway explains this failure" } }),
            { status }
          )
      )
    );
    await expect(agreementsClient(session).deploy("agr_a")).rejects.toMatchObject({
      status,
      message: "Gateway explains this failure",
    });
  });
});

describe("upload validation", () => {
  it("accepts text, Markdown, and HTML bundles without interpreting markup", () => {
    expect(() => validateUpload(upload)).not.toThrow();
    expect(() =>
      validateUpload({
        ...upload,
        documents: [
          { name: "a.HTML", text: "<html><body>A clause</body></html>" },
          { name: "addendum.txt", text: "Second clause" },
        ],
      })
    ).not.toThrow();
  });
  it("rejects missing documents, empty source and unsupported PDF", () => {
    expect(() => validateUpload({ ...upload, name: " " })).toThrow(/name/);
    expect(() => validateUpload({ ...upload, documents: [] })).toThrow(/at least one/);
    expect(() => validateUpload({ ...upload, documents: [{ name: "a.txt", text: " " }] })).toThrow(/empty/);
    expect(() => validateUpload({ ...upload, documents: [{ name: "a.pdf", text: "%PDF" }] })).toThrow(
      /PDF is not supported/
    );
  });
  it("counts UTF-8 bytes and the JSON envelope against server limits", () => {
    expect(() =>
      validateUpload({ ...upload, documents: [{ name: "a.txt", text: "€".repeat(710000) }] })
    ).toThrow(/2 MB/);
    expect(() =>
      validateUpload({
        ...upload,
        documents: [
          { name: "a.txt", text: "a".repeat(2 * 1024 * 1024) },
          { name: "b.txt", text: "b".repeat(2 * 1024 * 1024) },
        ],
      })
    ).toThrow(/4 MB/);
  });
});

describe("lifecycle gates and serial polling", () => {
  it("requires an authorized workspace, compiled token profile and reported signer to deploy", () => {
    const record = { status: "compiled", profile: "rwa-secondary" } as Agreement;
    const status = { chain: { chainId: 11155111 } } as StackStatus;
    expect(deployBlocked(record, status, true)).toBeNull();
    expect(deployBlocked(record, status, false)).toMatch(/demo workspace/);
    expect(deployBlocked(record, null, true)).toMatch(/signer/);
    expect(deployBlocked({ ...record, profile: "wildcat-credit" }, status, true)).toMatch(/not supported/);
    for (const state of ["extracting", "failed", "deploying", "deployed"] as const)
      expect(deployBlocked({ ...record, status: state }, status, true)).toMatch(/compiled/);
    expect(canRegenerate("failed")).toBe(true);
    expect(canRegenerate("deployed")).toBe(true);
    expect(canRegenerate("extracting")).toBe(false);
    expect(inFlight("deploying")).toBe(true);
    expect(inFlight("compiled")).toBe(false);
  });
  it("polls fast while extracting, slows once compiled, and never overlaps calls", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce("extracting").mockResolvedValue("compiled");
    const receive = vi.fn();
    const stop = poll(read, receive, vi.fn(), (state) => (state === "extracting" ? 2000 : 10000));
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenLastCalledWith("extracting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(receive).toHaveBeenLastCalledWith("compiled");
    await vi.advanceTimersByTimeAsync(9999);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("ignores a late result after selecting a different agreement", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const receive = vi.fn();
    const read = vi.fn((input: AbortSignal) => {
      signal = input;
      return new Promise<string>((done) => {
        resolve = done;
      });
    });
    const stop = poll(read, receive, vi.fn(), () => 2000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    expect(signal.aborted).toBe(true);
    resolve("obsolete");
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).not.toHaveBeenCalled();
  });
  it("surfaces errors and recovers on the next read without retrying a mutation", async () => {
    vi.useFakeTimers();
    const error = new Error("Offline");
    const fail = vi.fn();
    const receive = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("deployed");
    const stop = poll(read, receive, fail, () => 10000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fail).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(receive).toHaveBeenCalledWith("deployed");
    stop();
  });
});
