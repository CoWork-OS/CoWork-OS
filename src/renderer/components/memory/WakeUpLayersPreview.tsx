import { useEffect, useRef, useState } from "react";
import type { MemoryLayerPreviewPayload } from "../../../shared/types";
import { SettingsBadge } from "./SettingsRow";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The layers of the wake-up preview: what each adds to prompts and its budget. */
export function WakeUpLayersView({ preview }: { preview: MemoryLayerPreviewPayload | null }) {
  if (!preview) return <div className="settings-empty">Loading the preview...</div>;
  return (
    <div className="memory-layer-grid">
      {preview.layers.map((layer) => (
        <div key={layer.layer} className="memory-layer-card">
          <div className="memory-hub-row">
            <div className="memory-hub-section-title">{layer.title}</div>
            <SettingsBadge tone={layer.injectedByDefault ? "success" : "neutral"}>
              {layer.injectedByDefault ? "Injected" : "On demand"}
            </SettingsBadge>
          </div>
          <p className="settings-form-hint">{layer.description}</p>
          <div className="memory-hub-caption">
            {layer.budget.usedTokens} tokens used
            {layer.budget.excludedCount > 0
              ? ` • ${layer.budget.excludedCount} fragment${layer.budget.excludedCount === 1 ? "" : "s"} excluded by budget`
              : ""}
          </div>
          {layer.includedText ? (
            <pre className="memory-layer-text">{layer.includedText}</pre>
          ) : (
            <div className="settings-empty">No inline payload.</div>
          )}
          {layer.excludedText && <p className="settings-form-hint">{layer.excludedText}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * The preview of what the wake-up layers add to a prompt in this workspace; reloaded when
 * `refreshKey` changes (a setting that shapes it changed, a memory was promoted).
 */
export function WakeUpLayersPreview({
  workspaceId,
  refreshKey,
  onError,
}: {
  workspaceId: string;
  refreshKey: string;
  onError: (message: string) => void;
}) {
  const [preview, setPreview] = useState<MemoryLayerPreviewPayload | null>(null);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getMemoryLayerPreview(workspaceId)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) report.current(errorText(error, "Failed to load memory layer preview."));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  return <WakeUpLayersView preview={preview} />;
}
