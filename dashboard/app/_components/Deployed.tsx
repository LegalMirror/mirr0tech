"use client";

import { source } from "@/lib/adapter";
import { short } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import type { Deployment, ProfileId } from "@/lib/types";

const EXPLORER: Record<number, string> = { 11155111: "https://sepolia.etherscan.io" };
const CHAIN: Record<number, string> = { 11155111: "Sepolia", 31337: "local anvil" };

function contracts(d: Deployment, profile: ProfileId): [string, string][] {
  const shared: [string, string][] = [
    ["PolicyAttestor", d.attestor],
    ["Sanctions oracle", d.sanctions],
  ];
  return profile === "wildcat-credit"
    ? [
        ...shared,
        ["PolicyOracle", d.credit.oracle],
        ["Role provider", d.credit.roleProvider],
        ["Market", d.credit.market],
        ["SwapVM router", d.credit.router],
        ["1inch Aqua", d.credit.aqua],
      ]
    : [
        ...shared,
        ["PolicyOracle", d.rwa.oracle],
        ["Fund token", d.rwa.token],
        ["v4 hook", d.rwa.hook],
        ["Uniswap PoolManager", d.rwa.poolManager],
      ];
}

/** The contracts this profile compiled to, linked to the explorer when the chain has one. */
export function Deployed({ profile }: { profile: ProfileId }) {
  const { data } = useResource(() => source.deployment(), []);
  if (!data) return null;
  const explorer = EXPLORER[data.chainId];
  return (
    <section className="card deployed" aria-label="Deployed contracts">
      <span className="chip">{CHAIN[data.chainId] ?? `chain ${data.chainId}`}</span>
      {contracts(data, profile).map(([name, address]) => (
        <span key={name} className="deployed-item">
          <span className="muted small">{name}</span>{" "}
          {explorer ? (
            <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
              <code title={address}>{short(address, 6, 4)} ↗</code>
            </a>
          ) : (
            <code title={address}>{short(address, 6, 4)}</code>
          )}
        </span>
      ))}
    </section>
  );
}
