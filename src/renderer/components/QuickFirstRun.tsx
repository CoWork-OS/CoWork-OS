import { useEffect, useState } from "react";
import { getFirstRunReadiness } from "../../shared/first-run-readiness";
import { getModelAccessDescriptor } from "../../shared/model-access";

interface Props {
  onComplete: (choice: "ready" | "skipped" | "browsing_without_ai") => Promise<void>;
  onOpenSettings: () => Promise<void>;
}

export function QuickFirstRun({ onComplete, onOpenSettings }: Props) {
  const [screen, setScreen] = useState<"intro" | "model" | "boundaries">("intro");
  const [route, setRoute] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (screen !== "model") return;
    void window.electronAPI
      .getLLMSettings()
      .then((settings) => {
        const readiness = getFirstRunReadiness(settings);
        setRoute(
          readiness.modelReady && readiness.providerType
            ? getModelAccessDescriptor(readiness.providerType).label
            : null,
        );
      })
      .catch(() => setRoute(null));
  }, [screen]);

  const finish = async (choice: "ready" | "skipped" | "browsing_without_ai" | "connecting") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await (choice === "connecting" ? onOpenSettings() : onComplete(choice));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="quick-first-run" aria-label="First run setup">
      {screen === "intro" && (
        <>
          <h1>Try CoWork on a real task.</h1>
          <p>
            Turn a small sample release folder into a report and cleaned data. No personal files are
            needed. A configured AI provider may receive the sample content and charge for
            inference.
          </p>
          <button type="button" onClick={() => setScreen("model")}>
            Try the sample task
          </button>
          <button type="button" disabled={busy} onClick={() => void finish("skipped")}>
            Open my workspace instead
          </button>
          <button type="button" disabled={busy} onClick={() => void finish("browsing_without_ai")}>
            Explore without connecting AI
          </button>
        </>
      )}
      {screen === "model" && (
        <>
          <h1>Use the AI route you already have.</h1>
          <p>
            {route
              ? `${route} is configured. Authentication, model availability, and tool support are verified separately when you test or run it.`
              : "Connect an account, API key, gateway, or local model in AI & Models settings."}
          </p>
          <p>A hosted connection test may make a small billed request.</p>
          {route && (
            <button type="button" onClick={() => setScreen("boundaries")}>
              Continue with {route}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void finish("connecting")}>
            Open AI settings
          </button>
          <button type="button" disabled={busy} onClick={() => void finish("browsing_without_ai")}>
            Explore without AI
          </button>
        </>
      )}
      {screen === "boundaries" && (
        <>
          <h1>Review the sample boundaries.</h1>
          <p>
            CoWork will use a new private sample workspace and a tool policy limited to file
            operations. Shell, browser, external integrations, and task-tool network access are
            disabled. A cloud model still receives the sample files.
          </p>
          <p>
            Next, open the normal workspace and run the sample from its card. The same task
            timeline, approvals, artifacts, and follow-up composer handle the result.
          </p>
          <button type="button" disabled={busy} onClick={() => void finish("ready")}>
            Open workspace
          </button>
          <button type="button" onClick={() => setScreen("model")}>
            Back
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
