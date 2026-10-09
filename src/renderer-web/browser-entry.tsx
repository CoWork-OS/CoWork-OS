import React, { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { WEB_API_VERSION, type WebSessionBootstrap } from "../shared/host-api/contracts";
import { installBrowserHostBridge } from "../renderer/host/browser-host-bridge";
import { BrowserHostTransport, webEndpoint } from "./transport";
import "../renderer/react-refresh-ignored-exports";
import "../renderer/styles/index.css";
import "../renderer/styles/browser-workbench.css";
import "../renderer/components/right-panel.css";
import "../renderer/styles/calm-theme.css";
import "./browser-entry.css";

declare const __WEB_BUILD_ID__: string;

type BrowserApp = ComponentType;

type EntryState =
  | { kind: "loading"; message: string }
  | { kind: "connecting" }
  | { kind: "login"; error?: string }
  | { kind: "version_mismatch" }
  | { kind: "error"; message: string }
  | { kind: "ready"; App: BrowserApp };

type ActiveBridge = {
  transport: BrowserHostTransport;
  session: WebSessionBootstrap;
  removeStateListener: () => void;
  removeSignOutListener: () => void;
  disposeBridge: () => void;
  signingOut: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; data: T }> {
  const response = await fetch(webEndpoint(path), {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    throw new Error("The CoWork host returned an invalid response.");
  }
  return { response, data };
}

function BrowserEntry() {
  const [state, setState] = useState<EntryState>({
    kind: "loading",
    message: "Connecting to your CoWork host…",
  });
  const [pairingCode, setPairingCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const activeBridgeRef = useRef<ActiveBridge | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("browser-host");
    return () => document.documentElement.classList.remove("browser-host");
  }, []);

  const disposeActiveBridge = useCallback((expected?: ActiveBridge) => {
    const activeBridge = activeBridgeRef.current;
    if (!activeBridge || (expected && expected !== activeBridge)) return;
    activeBridgeRef.current = null;
    activeBridge.removeStateListener();
    activeBridge.removeSignOutListener();
    activeBridge.disposeBridge();
    activeBridge.transport.close();
  }, []);

  const openAppForSession = useCallback(
    async (session: WebSessionBootstrap, isActive: () => boolean) => {
      disposeActiveBridge();
      setUpdateAvailable(false);

      const transport = new BrowserHostTransport(session);
      let appMounted = false;
      let importingApp = false;
      const activeBridge: ActiveBridge = {
        transport,
        session,
        removeStateListener: () => {},
        removeSignOutListener: () => {},
        disposeBridge: () => {},
        signingOut: false,
      };
      activeBridge.disposeBridge = installBrowserHostBridge(transport, session);
      const signOut = async () => {
        if (activeBridge.signingOut || activeBridgeRef.current !== activeBridge) return;
        activeBridge.signingOut = true;
        try {
          const response = await fetch(webEndpoint("session/logout"), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "X-CoWork-CSRF": activeBridge.session.csrfToken },
          });
          if (!response.ok && response.status !== 401) {
            throw new Error("Could not sign out of this browser session.");
          }
          disposeActiveBridge(activeBridge);
          setState({ kind: "login" });
        } catch (error) {
          activeBridge.signingOut = false;
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not sign out of this browser session.",
          });
        }
      };
      window.addEventListener("cowork-browser-sign-out", signOut);
      activeBridge.removeSignOutListener = () =>
        window.removeEventListener("cowork-browser-sign-out", signOut);
      activeBridge.removeStateListener = transport.onState((connectionState) => {
        if (!isActive() || activeBridgeRef.current !== activeBridge) return;

        if (connectionState === "reauth_required") {
          disposeActiveBridge(activeBridge);
          setState({
            kind: "login",
            error:
              "Your browser session expired. Pair again to continue. Check the host task list before retrying an unconfirmed action.",
          });
          return;
        }
        if (connectionState === "version_mismatch") {
          disposeActiveBridge(activeBridge);
          setState({ kind: "version_mismatch" });
          return;
        }
        if (connectionState === "connected" && !appMounted && !importingApp) {
          importingApp = true;
          setState({ kind: "loading", message: "Opening CoWork OS…" });
          void import("../renderer/App")
            .then((module) => {
              if (!isActive() || activeBridgeRef.current !== activeBridge) return;
              if (transport.connectionState !== "connected") {
                importingApp = false;
                setState({ kind: "connecting" });
                return;
              }
              appMounted = true;
              setState({ kind: "ready", App: module.App });
            })
            .catch((error: unknown) => {
              if (!isActive() || activeBridgeRef.current !== activeBridge) return;
              disposeActiveBridge(activeBridge);
              setState({
                kind: "error",
                message: error instanceof Error ? error.message : "Could not open CoWork OS.",
              });
            });
        } else if (!appMounted && !importingApp) {
          setState({ kind: "connecting" });
        }
      });
      activeBridgeRef.current = activeBridge;
      setState({ kind: "connecting" });
      void transport.start();
    },
    [disposeActiveBridge],
  );

  const acceptSession = useCallback(
    async (session: WebSessionBootstrap, isActive: () => boolean = () => true) => {
      if (!isRecord(session) || session.apiVersion !== WEB_API_VERSION) {
        disposeActiveBridge();
        setState({ kind: "version_mismatch" });
        return;
      }
      await openAppForSession(session, isActive);
    },
    [disposeActiveBridge, openAppForSession],
  );

  const refreshSession = useCallback(
    async (isActive: () => boolean = () => true) => {
      const { response, data } = await readJson<unknown>("session/bootstrap");
      if (!isActive()) return;
      if (response.status === 401) {
        disposeActiveBridge();
        setState({ kind: "login" });
        return;
      }
      if (!isRecord(data) || data.apiVersion !== WEB_API_VERSION) {
        disposeActiveBridge();
        setState({ kind: "version_mismatch" });
        return;
      }
      if (!response.ok) {
        disposeActiveBridge();
        throw new Error("This browser application cannot connect to the host version.");
      }
      await acceptSession(data as unknown as WebSessionBootstrap, isActive);
    },
    [acceptSession, disposeActiveBridge],
  );

  useEffect(() => {
    let active = true;
    const isActive = () => active;

    async function load() {
      try {
        const { response, data } = await readJson<unknown>("bootstrap");
        if (!active) return;
        if (!isRecord(data) || data.apiVersion !== WEB_API_VERSION) {
          setState({ kind: "version_mismatch" });
          return;
        }
        if (!response.ok) throw new Error("This browser application cannot connect to the host.");
        await refreshSession(isActive);
      } catch (error) {
        if (active) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Could not reach the CoWork host.",
          });
        }
      }
    }

    void load();
    return () => {
      active = false;
      disposeActiveBridge();
    };
  }, [disposeActiveBridge, refreshSession]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    let active = true;
    const checkForUpdatedBuild = async () => {
      try {
        const response = await fetch(new URL("web-manifest.json", document.baseURI), {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const manifest: unknown = await response.json();
        if (
          active &&
          isRecord(manifest) &&
          typeof manifest.buildId === "string" &&
          manifest.buildId !== __WEB_BUILD_ID__
        ) {
          setUpdateAvailable(true);
        }
      } catch {
        // A temporary manifest read failure must not interrupt a connected task.
      }
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdatedBuild();
    };
    void checkForUpdatedBuild();
    const timer = window.setInterval(checkForUpdatedBuild, 30_000);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [state.kind]);

  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pairingCode.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { response } = await readJson<unknown>("session/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode.trim() }),
      });
      if (!response.ok) {
        setState({ kind: "login", error: "The pairing code was not accepted." });
        return;
      }
      setPairingCode("");
      await refreshSession();
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not reach the CoWork host.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const recheck = () => {
    setState({ kind: "loading", message: "Reconnecting to your CoWork host…" });
    void refreshSession().catch((error: unknown) => {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not reach the CoWork host.",
      });
    });
  };

  if (state.kind === "ready") {
    const App = state.App;
    return (
      <>
        <App />
        {updateAvailable && (
          <div className="browser-host-update-banner" role="status">
            <span>A newer CoWork interface is available.</span>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <main className="browser-entry">
      <section className="browser-entry-card" aria-live="polite">
        <div className="browser-entry-brand">
          <img src="./cowork-os-app-logo-dark.png" alt="" width="40" height="40" />
          <span>CoWork OS</span>
        </div>
        <h1>{state.kind === "login" ? "Connect to your workspace" : "Your CoWork workspace"}</h1>
        {(state.kind === "loading" || state.kind === "connecting") && (
          <p role="status">
            {state.kind === "loading" ? state.message : "Opening a secure connection to your host…"}
          </p>
        )}
        {state.kind === "login" && (
          <>
            <p className="browser-entry-description">
              Enter the pairing code from your CoWork OS app to get started.
            </p>
            <form className="browser-entry-form" onSubmit={(event) => void pair(event)}>
              <label htmlFor="browser-pairing-code">Pairing code</label>
              <input
                id="browser-pairing-code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Paste your pairing code"
                aria-describedby={state.error ? "browser-pairing-error" : undefined}
                aria-invalid={Boolean(state.error)}
                disabled={submitting}
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                required
              />
              <button type="submit" disabled={submitting || !pairingCode.trim()}>
                {submitting ? "Connecting…" : "Connect"}
              </button>
            </form>
            {state.error && (
              <p className="browser-entry-error" id="browser-pairing-error" role="alert">
                {state.error}
              </p>
            )}
          </>
        )}
        {state.kind === "version_mismatch" && (
          <>
            <p role="alert">The browser application and CoWork host versions do not match.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
        )}
        {state.kind === "error" && (
          <>
            <p role="alert">{state.message}</p>
            <button type="button" onClick={recheck}>
              Retry connection
            </button>
          </>
        )}
        {state.kind === "connecting" && (
          <button type="button" onClick={() => void activeBridgeRef.current?.transport.retryNow()}>
            Retry now
          </button>
        )}
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserEntry />
  </React.StrictMode>,
);
