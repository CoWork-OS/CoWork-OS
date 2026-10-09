import { useState } from "react";
import { AppWindow, Monitor } from "lucide-react";

export type BrowserScreenShareRequest = {
  requestId: string;
  tabId: string;
  origin: string;
  sources: Array<{ id: string; name: string; kind: "screen" | "window"; thumbnail: string }>;
};

function originLabel(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * The page asked to share a screen or window (getDisplayMedia). Nothing is
 * shared until a source is picked here; Cancel denies the request.
 */
export function ScreenSharePicker({
  request,
  onRespond,
}: {
  request: BrowserScreenShareRequest;
  onRespond: (requestId: string, sourceId: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="browser-workbench-page-dialog-layer">
      <div
        className="browser-workbench-page-dialog browser-workbench-screen-share"
        role="dialog"
        aria-modal="true"
        aria-label="Choose what to share"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onRespond(request.requestId, null);
          }
        }}
      >
        <strong>{originLabel(request.origin)} wants to share your screen</strong>
        <div className="browser-workbench-screen-share-grid" role="listbox" aria-label="Sources">
          {request.sources.map((source) => {
            const Icon = source.kind === "screen" ? Monitor : AppWindow;
            return (
              <button
                key={source.id}
                type="button"
                role="option"
                aria-selected={selected === source.id}
                className={selected === source.id ? "is-selected" : undefined}
                onClick={() => setSelected(source.id)}
                onDoubleClick={() => onRespond(request.requestId, source.id)}
              >
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" />
                ) : (
                  <span className="browser-workbench-screen-share-empty">
                    <Icon size={22} aria-hidden="true" />
                  </span>
                )}
                <span className="browser-workbench-screen-share-name">
                  <Icon size={12} aria-hidden="true" />
                  {source.name || (source.kind === "screen" ? "Screen" : "Window")}
                </span>
              </button>
            );
          })}
        </div>
        <div className="browser-workbench-page-dialog-actions">
          <button type="button" onClick={() => onRespond(request.requestId, null)}>
            Cancel
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!selected}
            onClick={() => selected && onRespond(request.requestId, selected)}
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
