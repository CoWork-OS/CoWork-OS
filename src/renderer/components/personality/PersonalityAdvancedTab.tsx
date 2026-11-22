import { useState } from "react";
import type { PersonalityConfigV2, ContextMode } from "../../../shared/types";

const CONTEXT_MODES: ContextMode[] = ["all", "coding", "chat", "planning", "writing", "research"];

interface PersonalityAdvancedTabProps {
  config: PersonalityConfigV2;
  onUpdate: (updates: Partial<PersonalityConfigV2>) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

interface PreviewRequest {
  config: PersonalityConfigV2;
  contextMode: ContextMode;
}

type PreviewState =
  | { request: PreviewRequest; status: "loading" }
  | { request: PreviewRequest; status: "ready" | "error"; text: string };

export function PersonalityAdvancedTab({
  config,
  onUpdate,
  onSave,
  saving,
}: PersonalityAdvancedTabProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewContextMode, setPreviewContextMode] = useState<ContextMode>("all");
  const [soulEditMode, setSoulEditMode] = useState(false);
  const [soulDraft, setSoulDraft] = useState(config.soulDocument ?? "");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileActionPending, setProfileActionPending] = useState(false);

  const activePreview =
    preview?.request.config === config && preview.request.contextMode === previewContextMode
      ? preview
      : null;
  const previewLoading = activePreview?.status === "loading";

  const runPreview = async () => {
    const request = { config, contextMode: previewContextMode };
    setPreview({ request, status: "loading" });
    let result: PreviewState;
    try {
      const text = await window.electronAPI.getPersonalityPreview(config, previewContextMode);
      result = { request, status: "ready", text };
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      result = { request, status: "error", text: `Could not create the preview.${detail}` };
    }
    setPreview((current) => (current?.request === request ? result : current));
  };

  const exportProfile = async (format: "json" | "md") => {
    setProfileError(null);
    setProfileActionPending(true);
    try {
      const data = await window.electronAPI.exportPersonalityProfile(format);
      const blob = new Blob([data], {
        type: format === "json" ? "application/json" : "text/markdown",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `personality-profile.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setProfileError(`Could not export the profile.${detail}`);
    } finally {
      setProfileActionPending(false);
    }
  };

  const importProfile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.md";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setProfileError(null);
      setProfileActionPending(true);
      try {
        const text = await file.text();
        await window.electronAPI.importPersonalityProfile(text);
        onUpdate(await window.electronAPI.getPersonalityConfigV2());
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        setProfileError(`Could not import the profile.${detail}`);
      } finally {
        setProfileActionPending(false);
      }
    };
    input.click();
  };

  const saveSoulDocument = () => {
    onUpdate({ soulDocument: soulDraft.trim() || undefined });
    onSave();
    setSoulEditMode(false);
  };

  return (
    <div className="personality-advanced-tab settings-section">
      <h3>Advanced</h3>
      <p className="settings-description">SOUL.md editor, preview, and import/export.</p>

      <div className="soul-editor">
        <h4>SOUL Document</h4>
        <p className="style-hint">
          Raw markdown override for power users. When set, used instead of structured fields.
        </p>
        {soulEditMode ? (
          <>
            <textarea
              className="settings-textarea soul-textarea"
              value={soulDraft}
              onChange={(e) => setSoulDraft(e.target.value)}
              rows={12}
              placeholder="# SOUL\n## Personality\n..."
            />
            <div className="soul-actions">
              <button className="button-primary" onClick={saveSoulDocument} disabled={saving}>
                Save
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setSoulEditMode(false);
                  setSoulDraft(config.soulDocument ?? "");
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="soul-preview-block">
            <pre className="soul-preview">
              {config.soulDocument?.trim() || "(Empty — using structured settings)"}
            </pre>
            <button
              type="button"
              className="button-small"
              onClick={() => {
                setSoulDraft(config.soulDocument ?? "");
                setSoulEditMode(true);
              }}
            >
              Edit
            </button>
          </div>
        )}
      </div>

      <div className="personality-preview-test">
        <h4>Personality Preview</h4>
        <p className="style-hint">Preview the system prompt for the selected context.</p>
        <div className="preview-controls">
          <select
            aria-label="Preview context"
            value={previewContextMode}
            onChange={(e) => {
              setPreviewContextMode(e.target.value as ContextMode);
              setPreview(null);
            }}
          >
            {CONTEXT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button-primary"
            onClick={runPreview}
            disabled={previewLoading}
          >
            {previewLoading ? "Loading..." : "Preview"}
          </button>
        </div>
        {activePreview?.status === "ready" && activePreview.text && (
          <pre className="preview-output">{activePreview.text}</pre>
        )}
        {activePreview?.status === "error" && (
          <p className="settings-alert settings-alert-error" role="alert">
            {activePreview.text}
          </p>
        )}
      </div>

      <div className="import-export">
        <h4>Import / Export</h4>
        <div className="import-export-buttons">
          <button
            type="button"
            className="button-primary"
            onClick={() => exportProfile("json")}
            disabled={profileActionPending}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => exportProfile("md")}
            disabled={profileActionPending}
          >
            Export SOUL.md
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={importProfile}
            disabled={profileActionPending}
          >
            Import
          </button>
        </div>
        {profileError && (
          <p className="settings-alert settings-alert-error" role="alert">
            {profileError}
          </p>
        )}
      </div>
    </div>
  );
}
