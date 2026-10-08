import { useCallback, useEffect, useState } from "react";
import type { PactAuthorizationView } from "../../../shared/pact";
import type { InputRequest } from "../../../shared/types";

interface PactAuthorizationCardProps {
  request: InputRequest;
  onCancel: () => void;
}

const REFRESH_MS = 5_000;

function minutesLeft(expiresAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000));
  if (minutes <= 0) return "expires in less than a minute";
  return minutes === 1 ? "expires in 1 minute" : `expires in ${minutes} minutes`;
}

/**
 * The task card for a PACT sign-in wait. The business's own login decides the outcome: there is
 * no "continue" button, only Open sign-in (the user's own browser) and Cancel. On the desktop the
 * link never reaches the renderer; main opens it. In the browser build the owner's session gets
 * the verified link and opens it in a new tab.
 */
export function PactAuthorizationCard({ request, onCancel }: PactAuthorizationCardProps) {
  const [view, setView] = useState<PactAuthorizationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await window.electronAPI.getPactAuthorizationForInput({
          inputRequestId: request.id,
        });
        if (!cancelled) {
          setView(next);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unavailable");
      }
      if (!cancelled) setNow(Date.now());
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [request.id]);

  const openSignIn = useCallback(async () => {
    if (!view) return;
    setOpening(true);
    setError(null);
    try {
      if (typeof window.electronAPI.getPactSignIn === "function") {
        // Browser build: the host cannot open a window on this device, so open a tab here.
        const signIn = await window.electronAPI.getPactSignIn({ id: view.id });
        setUserCode(signIn.userCode);
        window.open(signIn.verificationUriComplete, "_blank", "noopener,noreferrer");
      } else {
        const opened = await window.electronAPI.openPactSignIn({ id: view.id });
        setUserCode(opened.userCode);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "The sign-in could not be opened.");
    } finally {
      setOpening(false);
    }
  }, [view]);

  const businessName = view?.businessName ?? "the business";
  return (
    <div className="input-request-composer-shell" role="region" aria-label="Business sign-in required">
      <div className="input-request-card input-request-card-inline pact-authorization-card">
        <div className="input-request-progress">
          <span className="input-request-header">Sign in</span>
          {view && view.state === "pending" && (
            <span className="input-request-progress-index">{minutesLeft(view.expiresAt, now)}</span>
          )}
        </div>
        <div className="input-request-title">
          {`${businessName} asks you to sign in and approve access`}
        </div>
        {view?.purpose && <div className="pact-authorization-purpose">{view.purpose}</div>}
        {view && view.requestedScopes.length > 0 && (
          <ul className="pact-authorization-scopes" aria-label="Requested permissions">
            {view.requestedScopes.map((scope) => (
              // Descriptions are shown verbatim, as the business wrote them.
              <li key={scope.id}>
                <span className="pact-authorization-scope-description">{scope.description}</span>
                <span className="pact-authorization-scope-id">{scope.id}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="input-request-hint">
          {view?.verificationOrigin
            ? `The sign-in page is ${view.verificationOrigin}. CoWork never sees your password; you can uncheck any permission there.`
            : "The sign-in happens on the business's own page. CoWork never sees your password."}
        </div>
        {userCode && (
          <div className="input-request-hint pact-authorization-code">
            {`Check that the page shows the code ${userCode}.`}
          </div>
        )}
        {view && view.state !== "pending" && (
          <div className="input-request-hint">{`This sign-in is ${view.state}.`}</div>
        )}
        {error && <div className="input-request-hint pact-authorization-error">{error}</div>}
        <div className="input-request-actions">
          <button className="input-request-dismiss" onClick={onCancel}>
            Cancel sign-in
          </button>
          <button
            className="input-request-submit"
            onClick={() => void openSignIn()}
            disabled={!view || view.state !== "pending" || opening}
          >
            {opening ? "Opening…" : "Open sign-in"}
          </button>
        </div>
      </div>
    </div>
  );
}
