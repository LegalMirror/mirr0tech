import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static first: every screen reads JSON from /data (written by `pnpm run ui:export`) or, when
  // NEXT_PUBLIC_GATEWAY_URL is set, the operator gateway. `next build` emits a plain site in out/.
  output: "export",
  // A project site on GitHub Pages lives under /<repo>; the static adapter reads the same prefix.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // Every route is a directory with index.html, so the router's RSC prefetch for "/" resolves to
  // <basePath>/index.txt instead of a 404 at <basePath>.txt.
  trailingSlash: true,
  // Keep static export tracing scoped to the dashboard within the pnpm workspace.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};

export default nextConfig;
