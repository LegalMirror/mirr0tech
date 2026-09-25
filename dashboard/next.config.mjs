/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static first: every screen reads JSON from /data (written by `npm run ui:export`) or, when
  // NEXT_PUBLIC_GATEWAY_URL is set, the operator gateway. `next build` emits a plain site in out/.
  output: "export",
};

export default nextConfig;
