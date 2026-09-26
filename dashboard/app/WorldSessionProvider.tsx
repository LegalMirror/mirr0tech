"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { WorldLoginWidget, type LoginChallenge } from "./_components/WorldLoginWidget";
import { investorSession } from "@/lib/investor/session";
import { BASE } from "@/lib/base";
import { getSession, setSession } from "@/lib/session";
import { startDemoWorkspace } from "@/lib/demo-session";
import {
  clearWorldToken,
  restoreWorldToken,
  saveWorldToken,
  worldRequest,
  type WorldSession,
} from "@/lib/world-session";
import "./world-login.css";
import { observeWorldTransport, safeOrigin, worldDebugSummary } from "@/lib/world-diagnostics";

const Context = createContext<WorldSession | null>(null);
type LoginMode = "mock" | "sandbox" | "v3" | "production";
type ModeOption = { mode: LoginMode; environment: string; configured: boolean };
const MODE_LABEL: Record<LoginMode, string> = {
  mock: "Mock",
  sandbox: "Sandbox",
  v3: "Simulator (v3)",
  production: "World App (Orb)",
};
export function useWorldAccount() {
  return useContext(Context)?.account ?? null;
}

export function WorldSessionProvider({ children }: { children: ReactNode }) {
  const [url] = useState(() => getSession().url);
  const [session, setWorldSession] = useState<WorldSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<LoginMode>("mock");
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [existingSession, setExistingSession] = useState<`session_${string}` | undefined>();
  const transport = useRef<ReturnType<typeof observeWorldTransport> | null>(null);
  useEffect(() => {
    if (!challenge) return;
    const observer = observeWorldTransport();
    transport.current = observer;
    console.info("[World ID] handoff started", {
      environment: challenge.environment,
      flow:
        challenge.environment === "staging"
          ? "legacy-login"
          : existingSession
            ? "returning-session"
            : "new-session",
      gateway: safeOrigin(url),
      browserOnline: navigator.onLine,
      secureContext: window.isSecureContext,
      challengeExpiresAt: new Date(challenge.rp_context.expires_at * 1000).toISOString(),
    });
    return () => observer.stop();
  }, [challenge, mode, url, existingSession]);
  const forget = () => {
    clearWorldToken();
    investorSession.set(null);
    setWorldSession(null);
    setChallenge(null);
    setSession({ url, viewerKey: "", operatorKey: "", autoDemo: false });
  };
  useEffect(() => {
    let active = true;
    const expired = () => {
      forget();
      setError("Your session ended. Sign in again to continue.");
    };
    window.addEventListener("world-session-expired", expired);
    try {
      const hint = localStorage.getItem(`mirr0tech.world-resume:${url}`);
      if (hint && /^session_[a-f0-9]{128}$/i.test(hint)) setExistingSession(hint as `session_${string}`);
    } catch {
      /* Resume hints are optional. */
    }
    (async () => {
      try {
        const config = await worldRequest<{ configured: boolean; mode: LoginMode; modes?: ModeOption[] }>(
          url,
          "config"
        );
        if (!active) return;
        setConfigured(config.configured);
        setMode(config.mode);
        setModes(config.modes ?? []);
        if (restoreWorldToken(url)) {
          const restored = await worldRequest<WorldSession>(url, "session");
          if (!active) return;
          await startDemoWorkspace(url, true);
          if (active) setWorldSession(restored);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not connect to the login service.");
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
      window.removeEventListener("world-session-expired", expired);
    };
  }, [url]);
  useEffect(() => {
    if (!session) return;
    const check = () => {
      if (session.expiresAt * 1000 <= Date.now()) forget();
      else
        void worldRequest<WorldSession>(url, "session").catch(() => {
          /* 401 dispatches expiration. */
        });
    };
    const timer = setTimeout(forget, Math.max(0, session.expiresAt * 1000 - Date.now()));
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [session, url]);
  async function begin() {
    setBusy(true);
    setError("");
    try {
      if (mode === "mock") {
        const result = await worldRequest<WorldSession & { accessToken: string }>(url, "mock", {});
        saveWorldToken(url, result.accessToken);
        setWorldSession(result);
        void startDemoWorkspace(url, true);
        return;
      }
      setChallenge(
        await worldRequest<LoginChallenge>(url, "challenge", {
          existingSessionId: mode === "sandbox" ? existingSession : undefined,
          mode,
        })
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(proof: unknown) {
    if (!challenge) throw new Error("Start a new login attempt.");
    try {
      const result = await worldRequest<
        WorldSession & { accessToken: string; worldSessionId?: `session_${string}` }
      >(url, "verify", { challengeToken: challenge.challengeToken, proof });
      saveWorldToken(url, result.accessToken);
      // This is a proof target, never sufficient to authenticate without a fresh verified proof.
      try {
        if (result.worldSessionId)
          localStorage.setItem(`mirr0tech.world-resume:${url}`, result.worldSessionId);
      } catch {
        /* Optional. */
      }
      setExistingSession(result.worldSessionId);
      await startDemoWorkspace(url, true);
      setWorldSession(result);
      setChallenge(null);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
      setChallenge(null);
      throw cause;
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await worldRequest(url, "logout", {});
      forget();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (checking)
    return (
      <main className="world-loading" role="status">
        Restoring your World ID session…
      </main>
    );
  if (session)
    return (
      <Context.Provider value={session}>
        <div className="world-account-bar">
          <span>
            {session.account.mock
              ? "World ID · Mock session"
              : session.account.environment === "staging"
                ? "World ID · Simulator"
                : session.account.environment === "production"
                  ? "World ID · Orb"
                  : "World ID · Sandbox"}{" "}
            <span className="world-account-id">{session.account.id.slice(-8)}</span>
          </span>
          <button onClick={logout} disabled={busy}>
            Sign out
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
        {children}
      </Context.Provider>
    );
  return (
    <main className="world-landing">
      <header className="world-landing-header">
        <span className="world-brand">
          <img src={`${BASE}/mark.svg`} width="28" height="28" alt="" />
          mirr0tech
        </span>
        <span className="world-sandbox">
          {MODE_LABEL[mode]}
        </span>
      </header>
      <section className="world-hero">
        <div>
          <h1>Legalese to Code for RWAs</h1>
          <p className="world-intro">
            mirr0tech converts legalese into a mathematically verifiable abstract syntax tree which allows for
            safe and compliant management of RWA smart contracts.
          </p>
        </div>
        <div className="world-login-card">
          <span className="world-orbit" aria-hidden="true">
            ◎
          </span>
          <h2>Start tokenizing</h2>
          {modes.length > 1 && (
            <div className="world-mode-toggle" role="radiogroup" aria-label="Login mode">
              {modes.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.mode}
                  className={mode === option.mode ? "on" : ""}
                  disabled={busy || !option.configured}
                  title={option.configured ? option.environment : "Not configured on the backend"}
                  onClick={() => {
                    setMode(option.mode);
                    setConfigured(option.configured);
                    setError("");
                  }}
                >
                  {MODE_LABEL[option.mode]}
                </button>
              ))}
            </div>
          )}
          <button className="world-login-button" onClick={begin} disabled={busy || configured === false}>
            {busy ? "Preparing login…" : "Sign in with World ID"}
          </button>
          {configured === false && (
            <p role="status">
              World ID login needs the app ID, RP ID, and signing key configured on the backend. Simulator
              login also needs WORLD_LOGIN_ACTION.
            </p>
          )}
          {error && (
            <p className="world-login-error" role="alert">
              {error}
            </p>
          )}
          {mode === "mock" ? (
            <p className="world-login-note">Continue with a placeholder account. No QR code required.</p>
          ) : mode === "production" ? (
            <p className="world-login-note">Scan with World App on your phone. Needs an Orb-verified World ID.</p>
          ) : (
            <a
              href={mode === "v3" ? "https://simulator.worldcoin.org/" : "https://sandbox.auth.world.org/"}
              target="_blank"
              rel="noreferrer"
            >
              {mode === "v3" ? "Open World ID Simulator ↗" : "Open World ID Sandbox ↗"}
            </a>
          )}
          {mode === "sandbox" && existingSession && (
            <button
              className="world-reset"
              onClick={() => {
                setExistingSession(undefined);
                try {
                  localStorage.removeItem(`mirr0tech.world-resume:${url}`);
                } catch {}
              }}
            >
              Use a different World ID
            </button>
          )}
        </div>
      </section>
      {challenge && (
        <WorldLoginWidget
          challenge={challenge}
          existingSession={existingSession}
          onClose={() => setChallenge(null)}
          onProof={verify}
          onError={(code, debugReport) => {
            console.error("[World ID] handoff failed", {
              code,
              environment: challenge.environment,
              gateway: safeOrigin(url),
              browserOnline: navigator.onLine,
              secureContext: window.isSecureContext,
              debug: worldDebugSummary(debugReport),
              transport: transport.current?.events.slice() ?? [],
              challengeExpired: Date.now() >= challenge.rp_context.expires_at * 1000,
            });
            setError(
              `World ID login did not complete (${code}). Open the browser console and filter for [World ID] to see connection details, then try again.`
            );
            setChallenge(null);
          }}
        />
      )}
    </main>
  );
}
