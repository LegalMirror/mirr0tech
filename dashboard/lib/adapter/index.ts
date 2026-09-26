import { gatewaySource } from "./gateway";
import { staticSource } from "./static";
import { getSession, subscribeSession } from "../session";
import type { DataSource } from "./types";

export type { DataSource } from "./types";

export function selectSource(env: { gatewayUrl?: string } = {}): DataSource {
  return env.gatewayUrl ? gatewaySource(env.gatewayUrl) : staticSource;
}

const gateway = gatewaySource(() => getSession().url);
const current = () => (getSession().url ? gateway : staticSource);
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
  attest: (...args) => current().attest(...args),
  resolve: (...args) => current().resolve(...args),
  revoke: (...args) => current().revoke(...args),
  worldIdContext: () => current().worldIdContext(),
  verifyHuman: (...args) => current().verifyHuman(...args),
  subscribe(listener) {
    const stops = [gateway.subscribe(listener), staticSource.subscribe(listener), subscribeSession(listener)];
    return () => stops.forEach((stop) => stop());
  },
};
