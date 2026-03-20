import { useState } from "react";
import type { PersonalityConfigV2, ContextMode } from "../../../shared/types";

const CONTEXT_MODES: ContextMode[] = [
  "all",
  "coding",
  "chat",
  "planning",
  "writing",
  "research",
];

interface PersonalityAdvancedTabProps {
  config: PersonalityConfigV2;
  onUpdate: (updates: Partial<PersonalityConfigV2>) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

export function PersonalityAdvancedTab({
  config,
  onUpdate,
  onSave,
  saving,
}: PersonalityAdvancedTabProps) {
  const [previewResult, setPreviewResult] = useState("");
  const [previewContextMode, setPreviewContextMode] = useState<ContextMode>("all");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [soulEditMode, setSoulEditMode] = useState(false);
  const [soulDraft, setSoulDraft] = useState(config.soulDocument ?? "");

  const runPreview = async () => {
    setPreviewLoading(true);
    try {
      const result = await window.electronAPI.getPersonalityPreview(config, previewContextMode);
      setPreviewResult(result);
    } catch (err) {
      setPreviewResult(`Error: ${(err as Error).message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const exportProfile = async (format: "json" | "md") => {
    const data = await window.electronAPI.exportPersonalityProfile(format);
    const blob = new Blob([data], {
      type: format === "json" ? "application/json" : "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `personality-profile.${format === "json" ? "json" : "md"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importProfile = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.md";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      await window.electronAPI.importPersonalityProfile(text);
      onUpdate(await window.electronAPI.getPersonalityConfigV2());
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
      <p className="settings-description">
        SOUL.md editor, preview, and import/export.
      </p>

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
        <p className="style-hint">
          Enter a sample message and see the system prompt that would be sent.
        </p>
        <div className="preview-controls">
          <select
            value={previewContextMode}
            onChange={(e) => setPreviewContextMode(e.target.value as ContextMode)}
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
        {previewResult && (
          <pre className="preview-output">{previewResult}</pre>
        )}
      </div>

      <div className="import-export">
        <h4>Import / Export</h4>
        <div className="import-export-buttons">
          <button
            type="button"
            className="button-primary"
            onClick={() => exportProfile("json")}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => exportProfile("md")}
          >
            Export SOUL.md
          </button>
          <button type="button" className="button-secondary" onClick={importProfile}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
