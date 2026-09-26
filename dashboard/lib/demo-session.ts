import { worldSessionHeaders } from "./world-session";
import { gatewayUrl, getSession, hasGatewaySession, setSession } from "./session";

type Attempt = { url: string; pending: boolean; promise: Promise<void> };
let attempt: Attempt | null = null;
/** One bounded public attempt per load/URL; StrictMode and rerenders share it. Retry is explicit. */
export function startDemoWorkspace(rawUrl: string, retry = false): Promise<void> {
  const url = gatewayUrl(rawUrl);
  if (!url) return Promise.resolve();
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  if (!retry && hasGatewaySession(getSession()) && getSession().url === url) return Promise.resolve();
  if (attempt?.url === url && (attempt.pending || !retry)) return attempt.promise;
  setSession({
    url,
    viewerKey: "",
    operatorKey: "",
    autoDemo: false,
    demoState: "starting",
    demoNotice: "Connecting to your workspace…",
  });
  const revision = getSession().revision;
  const stillCurrent = () => getSession().url === url && getSession().revision === revision;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const run = async () => {
    try {
      if (local) {
        const configResponse = await fetch(`${url}/v1/workspace/config`, {
          headers: worldSessionHeaders(url),
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
        const config = await configResponse.json().catch(() => null);
        if (!configResponse.ok || config?.mode !== "local")
          throw new Error(
            "Start the local workspace with pnpm start, then reconnect. The server on this URL does not provide the workspace API."
          );
        const response = await fetch(`${url}/v1/workspace/session`, {
          method: "POST",
          headers: worldSessionHeaders(url),
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
        const value = await response.json().catch(() => null);
        if (
          !response.ok ||
          value?.role !== "workspace" ||
          typeof value.accessToken !== "string" ||
          !value.accessToken
        )
          throw new Error("Could not connect to the local workspace. Retry the connection.");
        if (stillCurrent())
          setSession({
            url,
            viewerKey: "",
            operatorKey: "",
            workspaceToken: value.accessToken,
            autoDemo: false,
            demoState: "ready",
            demoNotice:
              "Local workspace connected. Contracts and source files are saved on this machine and remain available after reload.",
          });
        return;
      }
      const configResponse = await fetch(`${url}/v1/demo/config`, {
        headers: worldSessionHeaders(url),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      const config = await configResponse.json().catch(() => null);
      if (!configResponse.ok || config?.enabled !== true)
        throw new Error(
          "Public contract creation is not enabled on this gateway yet. Exported samples remain available; retry after the demo API is deployed."
        );
      if (![31337, 11155111].includes(config.chainId))
        throw new Error("Public demo creation is only supported on local Anvil or Sepolia.");
      if (!stillCurrent()) return;
      const response = await fetch(`${url}/v1/demo/session`, {
        method: "POST",
        headers: worldSessionHeaders(url),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      const value = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          value?.error?.message ??
            `Could not create a demo workspace (${response.status}). Retry explicitly; no request is repeated automatically.`
        );
      if (
        value?.role !== "demo" ||
        typeof value.accessToken !== "string" ||
        !value.accessToken ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt * 1000 <= Date.now() ||
        value.chainId !== config.chainId
      )
        throw new Error(
          "The demo API returned an unsupported session. No authenticated workspace is claimed."
        );
      if (stillCurrent())
        setSession({
          url,
          viewerKey: "",
          operatorKey: "",
          demoToken: value.accessToken,
          demoExpiresAt: value.expiresAt,
          demoChainId: value.chainId,
          autoDemo: false,
          demoState: "ready",
          demoLimits: config.limits && typeof config.limits === "object" ? config.limits : undefined,
          demoCapabilities: {
            agreements: true,
            mutateAgreements: true,
            deploy: true,
            stack: false,
            admin: false,
          },
          demoNotice:
            "Your demo workspace is ready. It contains only documents created in this session. Reloading starts a new workspace; tokens are not saved.",
        });
    } catch (error) {
      if (stillCurrent())
        setSession({
          url,
          viewerKey: "",
          operatorKey: "",
          autoDemo: false,
          demoState: "unavailable",
          demoNotice: controller.signal.aborted
            ? local
              ? "Workspace connection timed out. Check that pnpm start is running, then reconnect."
              : "Demo connection timed out. Samples are still readable. Retry explicitly to create a new workspace."
            : error instanceof TypeError
              ? local
                ? "Could not reach the local workspace. Run pnpm start and reconnect to http://localhost:3000."
                : "Could not reach the public demo API. Check the gateway URL/network/CORS or retry after its update. Samples remain available."
              : (error as Error).message,
        });
    } finally {
      clearTimeout(timeout);
      if (attempt?.url === url) attempt.pending = false;
    }
  };
  const promise = run();
  attempt = { url, pending: true, promise };
  return promise;
}
