import { useMemo, useEffect, useSyncExternalStore, useState } from "react";
import type { BotWorkItem } from "../../shared/types";
import { BotWorkResultLoader } from "../utils/bot-work-result-loader";
import { hasHostMethods } from "../host/browser-capabilities";
/** The recorded verification verdict, in plain words. */
const verificationLabels: Record<BotWorkItem["verification"], string> = {
  passed: "Checked",
  partial: "Partly checked",
  failed: "Check failed",
  unverified: "Not checked",
};
const outputLabels = {
  matches: "Current file matches this revision",
  changed: "File changed since this revision",
  missing: "File is missing",
  unavailable: "Current file could not be checked",
  not_current: "Revision is not current",
};
export function BotWorkResultCard({
  item,
  workspaceId,
  botId,
  onOpenWork,
}: {
  item: BotWorkItem;
  workspaceId: string;
  botId: string;
  onOpenWork: () => void;
}) {
  const [open, setOpen] = useState(false);
  const available =
    hasHostMethods("getBotWorkResult") && typeof window.electronAPI.getBotWorkResult === "function";
  const loader = useMemo(
    () =>
      new BotWorkResultLoader((request) => window.electronAPI.getBotWorkResult(request), {
        workspaceId,
        agentRoleId: botId,
        taskId: item.taskId!,
      }),
    [workspaceId, botId, item.taskId, item.updatedAt],
  );
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  useEffect(() => {
    loader.activate();
    if (open && available) void loader.load();
    return () => loader.dispose();
  }, [loader, open, available]);
  const result =
    state.result?.request.workspaceId === workspaceId &&
    state.result.request.agentRoleId === botId &&
    state.result.request.taskId === item.taskId
      ? state.result
      : null;
  return (
    <section className="bot-result-card" aria-label="Result">
      <p>{item.resultSummary || "No summary recorded."}</p>
      <div className="bot-result-row">
        <span className={`bot-result-verdict ${item.verification}`}>
          {verificationLabels[item.verification]}
        </span>
        <button
          type="button"
          disabled={!available || !item.taskId}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={available ? undefined : "Result details are unavailable here"}
        >
          {open ? "Hide details" : "Details"}
        </button>
        {item.taskId ? (
          <button type="button" onClick={onOpenWork}>
            Open
          </button>
        ) : null}
      </div>
      {open && (
        <div aria-live="polite">
          {state.loading && <p>Checking saved evidence and current output files…</p>}
          {state.error && <p role="alert">{state.error}</p>}
          {!state.loading && (
            <button type="button" onClick={() => void loader.load()}>
              Check again
            </button>
          )}
          {result && (
            <>
              {result.contract ? (
                <>
                  <h4>Goal</h4>
                  <p>{result.contract.objective}</p>
                  <p className="bot-work-note">
                    Saved contract revision {result.contract.version} · {result.contract.status}
                  </p>
                  <h4>Checks</h4>
                  <ul>
                    {result.contract.requirements.map((r) => (
                      <li key={r.id}>
                        <span>{r.description}</span>
                        <p className="bot-work-note">
                          {r.required ? "Required" : "Optional"} · recorded {r.status} · current
                          file evidence {r.currentEvidence}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>No outcome contract was saved for this work.</p>
              )}
              <h4>Files</h4>
              {result.outputs.length ? (
                <ul>
                  {result.outputs.map((o) => (
                    <li key={o.id}>
                      <strong>{o.path}</strong>
                      <p>
                        Revision {o.revision} · {outputLabels[o.check]}
                      </p>
                      <p className="bot-work-note">
                        SHA-256: <code>{o.sha256}</code>
                        {o.reason ? ` · ${o.reason}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No artifact revisions were saved for this work.</p>
              )}
              <p className="bot-work-note">
                File presence and revision checks were made at{" "}
                {new Date(result.checkedAt).toLocaleString()}. Content quality and external delivery
                require their own proof.
              </p>
              <h4>Sources</h4>
              {result.evidence.length ? (
                <ul>
                  {result.evidence.map((e) => (
                    <li key={e.id}>
                      {e.claim}
                      <p className="bot-work-note">
                        {e.sourceType} · {e.status} · {new Date(e.capturedAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No evidence entries were saved.</p>
              )}
              {result.truncated && (
                <p className="bot-work-note">
                  This bounded view omits additional evidence. Open the work item for its complete
                  history.
                </p>
              )}
              {result.issues.map((issue) => (
                <p key={issue} role="status">
                  {issue}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
