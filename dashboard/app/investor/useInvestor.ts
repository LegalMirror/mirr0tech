"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { investorClient, InvestorApiError } from "@/lib/investor/api";
import { investorSession, serverInvestorSession, sessionAlive } from "@/lib/investor/session";
import { SEPOLIA, type InvestorConfig, type PublicFund } from "@/lib/investor/types";
import {
  connectWallet,
  injectedWallet,
  observeWallet,
  switchToSepolia,
  walletError,
  walletIdentity,
  type Eip1193Provider,
  type WalletIdentity,
} from "@/lib/investor/wallet";

export function useInvestor() {
  const client = useMemo(() => investorClient(), []);
  const session = useSyncExternalStore(investorSession.subscribe, investorSession.get, serverInvestorSession);
  const [config, setConfig] = useState<InvestorConfig | null>(null);
  const [funds, setFunds] = useState<PublicFund[]>([]);
  const [fundId, setFundId] = useState("");
  const [publicError, setPublicError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [wallet, setWallet] = useState<WalletIdentity | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const active = useRef(true);
  const operations = useRef(new Set<AbortController>());
  const invalidate = useCallback((message: string) => {
    epoch.current++;
    operations.current.forEach((operation) => operation.abort());
    operations.current.clear();
    investorSession.set(null);
    setRevision((value) => value + 1);
    setNotice(message);
  }, []);
  const report = useCallback(
    (error: unknown) => {
      const text = walletError(error);
      if (
        error instanceof InvestorApiError &&
        (error.status === 401 || ["SESSION_CONTEXT_CHANGED", "CHAIN_BINDING_CHANGED"].includes(error.code))
      )
        invalidate(text);
      else setNotice(text);
    },
    [invalidate]
  );
  const begin = useCallback(() => {
    const started = epoch.current;
    const controller = new AbortController();
    operations.current.add(controller);
    return {
      signal: controller.signal,
      current: () => active.current && started === epoch.current && !controller.signal.aborted,
      finish: () => {
        operations.current.delete(controller);
      },
    };
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current++;
      operations.current.forEach((operation) => operation.abort());
      operations.current.clear();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPublicError("");
    Promise.all([client.config(controller.signal), client.funds(controller.signal)])
      .then(([configuration, available]) => {
        if (controller.signal.aborted) return;
        setConfig(configuration);
        setFunds(available);
        setFundId((id) =>
          available.some((fund) => fund.id === id)
            ? id
            : (available.find((fund) => fund.id === investorSession.get()?.session.fundId)?.id ??
              available.find((fund) => fund.cashier && !fund.disabledReason)?.id ??
              available[0]?.id ??
              "")
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setPublicError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, refresh]);
  useEffect(() => {
    setProvider(injectedWallet());
  }, []);
  useEffect(() => {
    const injected = provider;
    if (!injected) return;
    let mounted = true;
    const sync = async () => {
      try {
        const identity = await walletIdentity(injected);
        if (!mounted) return;
        setWallet(identity);
        const current = investorSession.get();
        if (
          current &&
          (current.session.wallet.toLowerCase() !== identity.address.toLowerCase() ||
            identity.chainId !== SEPOLIA)
        )
          invalidate("Wallet does not match the remembered in-memory investor session. Sign in again.");
      } catch {
        if (mounted) {
          setWallet(null);
          if (investorSession.get()) invalidate("Wallet is no longer connected. Investor session cleared.");
        }
      }
    };
    void sync();
    const stop = observeWallet(injected, (reason) => {
      invalidate(reason);
      setWallet(null);
      void sync();
    });
    return () => {
      mounted = false;
      stop();
    };
  }, [provider, invalidate]);
  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      invalidate("Investor session expired. Sign in again; no queued transaction was sent.");
      return;
    }
    const timer = setTimeout(
      () =>
        invalidate(
          "Investor session expired. Sign in again. Any transaction already broadcast remains on-chain; inspect its receipt before retrying."
        ),
      Math.min(remaining, 2147483647)
    );
    return () => clearTimeout(timer);
  }, [session, invalidate]);
  useEffect(() => {
    if (!session || !funds.length) return;
    const current = funds.find((fund) => fund.id === session.session.fundId);
    if (
      !current ||
      current.policyHash.toLowerCase() !== session.session.policyHash.toLowerCase() ||
      current.chainId !== session.session.chainId
    )
      invalidate("The published fund policy changed. Sign in again before preparing another transaction.");
  }, [funds, session, invalidate]);
  async function connect(switchChain = false) {
    setConnecting(true);
    setNotice("");
    try {
      const injected = injectedWallet();
      if (!injected)
        throw new Error(
          "No injected EIP-1193 wallet was found. Open this page in a Sepolia-capable wallet browser or install a browser wallet. World MiniKit cannot sign Sepolia transactions."
        );
      if (!injected.on || !injected.removeListener)
        throw new Error(
          "This provider does not expose wallet account/chain change events. Use an EIP-1193 browser wallet that supports them; no sign-in or write will be queued."
        );
      if (!provider) setProvider(injected);
      const identity = switchChain ? await switchToSepolia(injected) : await connectWallet(injected);
      if (active.current) setWallet(identity);
    } catch (error) {
      if (active.current) report(error);
    } finally {
      if (active.current) setConnecting(false);
    }
  }
  const fund = funds.find((fund) => fund.id === fundId) ?? null;
  const ready =
    !!session &&
    sessionAlive(session) &&
    !!wallet &&
    wallet.chainId === SEPOLIA &&
    wallet.address.toLowerCase() === session.session.wallet.toLowerCase() &&
    session.session.fundId === fund?.id &&
    !publicError;
  return {
    client,
    config,
    funds,
    fund,
    loading,
    publicError,
    provider,
    wallet,
    connecting,
    notice,
    revision,
    session,
    ready,
    begin,
    report,
    invalidate,
    connect,
    clearNotice: () => setNotice(""),
    refreshPublic: () => setRefresh((value) => value + 1),
    selectFund: (id: string) => {
      invalidate(
        "Fund changed. Sign in for this fund; investor sessions never grant access to another fund or issuer routes."
      );
      setFundId(id);
    },
  };
}
export type InvestorState = ReturnType<typeof useInvestor>;
