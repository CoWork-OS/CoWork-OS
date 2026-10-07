import { useMemo, useState } from "react";
import {
  MEMORY_EXPORT_PROMPT,
  TEXT_MEMORY_IMPORT_CATEGORIES,
  type TextMemoryImportCategory,
} from "../../shared/memory-import-prompt";

interface TextMemoryImportResult {
  success: boolean;
  entriesDetected: number;
  memoriesCreated: number;
  duplicatesSkipped: number;
  truncated: number;
  errors: string[];
  byCategory?: Partial<Record<string, number>>;
  incomplete?: boolean;
}

interface PromptMemoryImportWizardProps {
  workspaceId: string;
  onClose: () => void;
  onImportComplete?: () => void;
}

const PROVIDER_OPTIONS = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "Meta AI",
  "Perplexity",
  "Copilot",
  "Grok",
  "Other",
] as const;

const CATEGORY_LABELS: Record<TextMemoryImportCategory, string> = {
  instructions: "instructions",
  identity: "identity",
  career: "career",
  projects: "projects",
  preferences: "preferences",
};

export function PromptMemoryImportWizard({
  workspaceId,
  onClose,
  onImportComplete,
}: PromptMemoryImportWizardProps) {
  const [provider, setProvider] = useState<string>("ChatGPT");
  const [customProvider, setCustomProvider] = useState<string>("");
  const [pastedText, setPastedText] = useState<string>("");
  const [forcePrivate, setForcePrivate] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<TextMemoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvedProvider = useMemo(() => {
    const value = provider === "Other" ? customProvider.trim() : provider.trim();
    return value || "";
  }, [provider, customProvider]);

  const handleCopyPrompt = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(MEMORY_EXPORT_PROMPT);
      } else {
        const temp = document.createElement("textarea");
        temp.value = MEMORY_EXPORT_PROMPT;
        temp.style.position = "fixed";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.focus();
        temp.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(temp);
        if (!copied) throw new Error("Copy failed");
      }
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
    }
  };

  const handleImport = async () => {
    if (!resolvedProvider) {
      setError("Enter the name of the assistant you exported from.");
      return;
    }
    if (!pastedText.trim()) {
      setError("Paste the exported memory text first.");
      return;
    }

    setImporting(true);
    setError(null);
    try {
      const importResult = await window.electronAPI.importMemoryFromText({
        workspaceId,
        provider: resolvedProvider,
        pastedText,
        forcePrivate,
      });
      setResult(importResult);
      if (importResult.memoriesCreated > 0) {
        onImportComplete?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed unexpectedly.");
    } finally {
      setImporting(false);
    }
  };

  const hasCreatedMemories = (result?.memoriesCreated || 0) > 0;
  const categoryBreakdown = TEXT_MEMORY_IMPORT_CATEGORIES.map((category) => ({
    category,
    count: result?.byCategory?.[category] ?? 0,
  })).filter((item) => item.count > 0);

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div
        className="mcp-modal memory-text-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-text-import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <h3 id="memory-text-import-title">Import memory to CoWork</h3>
          <button className="mcp-modal-close" onClick={onClose} aria-label="Close import popup">
            ✕
          </button>
        </div>
        <div className="mcp-modal-content">
          {!result && (
            <ol className="memory-text-import-steps">
              <li className="memory-text-import-step">
                <span className="chatgpt-import-step-number" aria-hidden="true">
                  1
                </span>
                <div className="memory-text-import-step-body">
                  <div className="memory-text-import-step-title">
                    Copy this prompt into a chat with your other AI provider
                  </div>
                  <div
                    className={`memory-text-import-prompt${promptExpanded ? " is-expanded" : ""}`}
                  >
                    <pre tabIndex={0} aria-label="Memory export prompt">
                      {MEMORY_EXPORT_PROMPT}
                    </pre>
                    <div className="memory-text-import-prompt-actions">
                      <button
                        type="button"
                        className="settings-button"
                        onClick={() => setPromptExpanded((value) => !value)}
                      >
                        {promptExpanded ? "Collapse" : "Show all"}
                      </button>
                      <button type="button" className="settings-button" onClick={handleCopyPrompt}>
                        {copyState === "copied" ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  {copyState === "error" && (
                    <span className="memory-text-import-note is-error">
                      Could not copy automatically. Select the prompt and copy it manually.
                    </span>
                  )}
                </div>
              </li>

              <li className="memory-text-import-step">
                <span className="chatgpt-import-step-number" aria-hidden="true">
                  2
                </span>
                <div className="memory-text-import-step-body">
                  <label
                    className="memory-text-import-step-title"
                    htmlFor="memory-text-import-paste"
                  >
                    Paste results below to add to CoWork's memory
                  </label>
                  <textarea
                    id="memory-text-import-paste"
                    className="memory-text-import-paste"
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    placeholder="Paste your memory details here"
                  />
                  <div className="memory-text-import-options">
                    <label className="memory-text-import-option">
                      <span>Exported from</span>
                      <select
                        className="settings-select"
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                      >
                        {PROVIDER_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    {provider === "Other" && (
                      <input
                        className="settings-input"
                        type="text"
                        value={customProvider}
                        onChange={(e) => setCustomProvider(e.target.value)}
                        placeholder="Assistant name"
                        aria-label="Assistant name"
                      />
                    )}
                    <label className="memory-text-import-option">
                      <input
                        type="checkbox"
                        checked={forcePrivate}
                        onChange={(e) => setForcePrivate(e.target.checked)}
                      />
                      <span>Keep private (used only in this workspace)</span>
                    </label>
                  </div>
                </div>
              </li>
            </ol>
          )}

          {!result && error && <div className="chatgpt-import-error">{error}</div>}

          {!result && (
            <div className="memory-text-import-footer">
              <button className="chatgpt-import-btn chatgpt-import-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="chatgpt-import-btn chatgpt-import-btn-primary"
                onClick={handleImport}
                disabled={importing || !pastedText.trim()}
              >
                {importing ? "Adding..." : "Add to memory"}
              </button>
            </div>
          )}

          {result && (
            <div className="chatgpt-import-step">
              <div
                className={`chatgpt-import-result ${hasCreatedMemories ? "chatgpt-import-result-success" : "chatgpt-import-result-error"}`}
              >
                <h4 className="memory-text-import-result-title">
                  {hasCreatedMemories ? "Added to memory" : "No memories added"}
                </h4>
                <div className="chatgpt-import-result-stats">
                  <div className="chatgpt-import-result-stat">
                    <strong>{result.entriesDetected}</strong>
                    <span>entries detected</span>
                  </div>
                  <div className="chatgpt-import-result-stat">
                    <strong>{result.memoriesCreated}</strong>
                    <span>memories created</span>
                  </div>
                  {result.duplicatesSkipped > 0 && (
                    <div className="chatgpt-import-result-stat">
                      <strong>{result.duplicatesSkipped}</strong>
                      <span>skipped (duplicate or filtered)</span>
                    </div>
                  )}
                  {result.truncated > 0 && (
                    <div className="chatgpt-import-result-stat">
                      <strong>{result.truncated}</strong>
                      <span>entries not imported (limit)</span>
                    </div>
                  )}
                </div>
                {categoryBreakdown.length > 0 && (
                  <p className="memory-text-import-note">
                    {categoryBreakdown
                      .map(({ category, count }) => `${count} ${CATEGORY_LABELS[category]}`)
                      .join(" · ")}
                  </p>
                )}
                {result.incomplete && (
                  <p className="memory-text-import-note">
                    {resolvedProvider} said more memories remain. Ask it to continue, then import
                    the rest — entries already added are skipped.
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="memory-text-import-note is-error">{result.errors[0]}</p>
                )}
              </div>

              <div className="chatgpt-import-actions">
                <button className="chatgpt-import-btn chatgpt-import-btn-primary" onClick={onClose}>
                  Done
                </button>
                <button
                  className="chatgpt-import-btn chatgpt-import-btn-secondary"
                  onClick={() => {
                    setResult(null);
                    setPastedText("");
                    setError(null);
                  }}
                >
                  {result.incomplete ? "Import the rest" : "Import another"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
