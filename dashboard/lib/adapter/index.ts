import { gatewaySource } from "./gateway";
import { staticSource } from "./static";
import type { DataSource } from "./types";

export type { DataSource } from "./types";

/** Static JSON by default; the operator gateway when NEXT_PUBLIC_GATEWAY_URL is set at build time. */
export function selectSource(env: { gatewayUrl?: string } = {}): DataSource {
  return env.gatewayUrl ? gatewaySource(env.gatewayUrl) : staticSource;
}

export const source: DataSource = selectSource({ gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL });
