import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { ConnectorBrandIcon } from "./ConnectorBrandIcon";
import { readConnectorReadiness, type ConnectorReadiness } from "../utils/contextual-connectors";
import type { ConnectorSetupRequest } from "../hooks/useContextualConnectorSetup";
import "./contextual-connector-setup.css";

const ConnectorsSettings = lazy(() =>
  import("./ConnectorsSettings").then((module) => ({ default: module.ConnectorsSettings })),
);

export function ContextualConnectorSetup({
  request,
  onResolve,
}: {
  request: ConnectorSetupRequest;
  onResolve: (proceed: boolean) => void;
}) {
  const [readiness, setReadiness] = useState<Record<string, ConnectorReadiness>>({});
  const [checking, setChecking] = useState(false);
  const [setupId, setSetupId] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const generation = useRef(0);
  const refresh = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    const token = generation.current;
    try {
      const statuses = await Promise.all(
        request.connectors.map(
          async (connector) => [connector.id, await readConnectorReadiness(connector)] as const,
        ),
      );
      if (token === generation.current) setReadiness(Object.fromEntries(statuses));
    } finally {
      if (token === generation.current) {
        checkingRef.current = false;
        setChecking(false);
      }
    }
  };
  useEffect(() => {
    generation.current += 1;
    checkingRef.current = false;
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [request]);
  const ready = request.connectors.every((connector) => readiness[connector.id]?.connected);
  const selected = request.connectors.find((connector) => connector.id === setupId);
  return (
    <div className="mcp-modal-overlay">
      <ModalDialog
        className="contextual-connector-setup"
        aria-label="Connect apps for your task"
        onClose={() => onResolve(false)}
      >
        <header>
          <h2>Connect apps for this task</h2>
          <p>Your request stays here while you connect. Review the account in each app’s setup.</p>
        </header>
        <blockquote>{request.prompt}</blockquote>
        <div className="contextual-connector-list">
          {request.connectors.map((connector) => (
            <div key={connector.id} className="contextual-connector-row">
              <ConnectorBrandIcon
                connectorKey={connector.selection.targetId || connector.id}
                name={connector.name}
              />
              <div>
                <strong>{connector.name}</strong>
                <p role="status">
                  {readiness[connector.id]?.connected
                    ? `Connected${readiness[connector.id]?.account ? ` · ${readiness[connector.id].account}` : ""}`
                    : readiness[connector.id]?.error || "Connection needed"}
                </p>
              </div>
              <button className="button-secondary" onClick={() => setSetupId(connector.id)}>
                {readiness[connector.id]?.connected ? "Review account" : "Set up"}
              </button>
            </div>
          ))}
        </div>
        {selected && (
          <section className="contextual-connector-settings">
            <button
              className="button-secondary"
              onClick={() => {
                setSetupId(null);
                void refresh();
              }}
            >
              Back to task setup
            </button>
            <Suspense fallback={<p role="status">Opening connector setup…</p>}>
              <ConnectorsSettings
                key={selected.id}
                initialSelection={selected.selection}
                onSetupClosed={() => {
                  setSetupId(null);
                  void refresh();
                }}
              />
            </Suspense>
          </section>
        )}
        <p className="contextual-connector-note">
          Your task starts when you continue. Its existing access and approval settings still apply.
        </p>
        <footer>
          <button className="button-secondary" onClick={() => onResolve(false)}>
            Back to request
          </button>
          <button className="button-secondary" onClick={() => void refresh()} disabled={checking}>
            {checking ? "Checking…" : "Check connection"}
          </button>
          <button className="button-primary" disabled={checking} onClick={() => onResolve(true)}>
            {ready ? "Continue task" : "Continue without connecting"}
          </button>
        </footer>
      </ModalDialog>
    </div>
  );
}
