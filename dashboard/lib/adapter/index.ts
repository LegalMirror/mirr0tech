import { gatewaySource } from "./gateway";
import { staticSource } from "./static";
import { getSession, hasInternalSession, subscribeSession } from "../session";
import type { DataSource } from "./types";

export type { DataSource } from "./types";

export function selectSource(env: { gatewayUrl?: string } = {}): DataSource {
  return env.gatewayUrl ? gatewaySource(env.gatewayUrl) : staticSource;
}

const gateway = gatewaySource(() => getSession().url);
const current = () => (hasInternalSession(getSession()) ? gateway : staticSource);
function writable() {
  if (!getSession().operatorKey)
    throw new Error(
      "Classic admin mutations are unavailable in public demo/investor sessions. Use the investor dashboard for permitted wallet actions."
    );
  return gateway;
}
// The older dashboard routes share the workbench's in-memory connection, without persisting keys.
export const source: DataSource = {
  get kind() {
    return current().kind;
  },
  profiles: () => current().profiles(),
  policy: (...args) => current().policy(...args),
  parties: (...args) => current().parties(...args),
  audit: (...args) => current().audit(...args),
  deployment: () => current().deployment(),
  attest: async (...args) => writable().attest(...args),
  resolve: async (...args) => writable().resolve(...args),
  revoke: async (...args) => writable().revoke(...args),
  worldIdContext: () => current().worldIdContext(),
  verifyHuman: async (...args) => writable().verifyHuman(...args),
  subscribe(listener) {
    const stops = [gateway.subscribe(listener), staticSource.subscribe(listener), subscribeSession(listener)];
    return () => stops.forEach((stop) => stop());
  },
};
