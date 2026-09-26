import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static first: every screen reads JSON from /data (written by `npm run ui:export`) or, when
  // NEXT_PUBLIC_GATEWAY_URL is set, the operator gateway. `next build` emits a plain site in out/.
  output: "export",
  // A project site on GitHub Pages lives under /<repo>; the static adapter reads the same prefix.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // Every route is a directory with index.html, so the router's RSC prefetch for "/" resolves to
  // <basePath>/index.txt instead of a 404 at <basePath>.txt.
  trailingSlash: true,
  // The repository root has its own lockfile; this app is its own root.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};

export default nextConfig;
