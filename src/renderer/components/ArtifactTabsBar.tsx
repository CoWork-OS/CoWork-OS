import { X } from "lucide-react";
import { FileChipIcon } from "./markdown-components";
import { artifactTabLabels, type ArtifactTab } from "../utils/artifact-tabs";

/** The files open in the side panel; shown when there is more than one. */
export function ArtifactTabsBar({
  tabs,
  activePath,
  onSelect,
  onClose,
}: {
  tabs: readonly ArtifactTab[];
  activePath: string | null;
  onSelect: (tab: ArtifactTab) => void;
  onClose: (tab: ArtifactTab) => void;
}) {
  if (tabs.length < 2) return null;
  const labels = artifactTabLabels(tabs);
  return (
    <div className="artifact-tabs" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const label = labels.get(tab.path) ?? tab.path;
        return (
          <div key={tab.path} className={`artifact-tab${active ? " active" : ""}`} title={tab.path}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="artifact-tab-select"
              onClick={() => {
                if (!active) onSelect(tab);
              }}
              onAuxClick={(event) => {
                // Middle-click closes, as in a browser.
                if (event.button === 1) onClose(tab);
              }}
            >
              <FileChipIcon filePath={tab.path} />
              <span className="artifact-tab-label">{label}</span>
            </button>
            <button
              type="button"
              className="artifact-tab-close"
              onClick={() => onClose(tab)}
              aria-label={`Close ${label}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
