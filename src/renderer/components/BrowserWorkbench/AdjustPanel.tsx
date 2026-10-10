import { useEffect, useRef, useState } from "react";
import type { AdjustChanges, AdjustKey } from "./adjust-changes";

/** Style fields "Adjust" edits, with the annotation style patch key each one maps to. */
const FIELDS: Array<{
  key: AdjustKey;
  label: string;
  placeholder: string;
}> = [
  { key: "fontFamily", label: "Font", placeholder: "Inter, sans-serif" },
  { key: "fontSize", label: "Size", placeholder: "16px" },
  { key: "fontWeight", label: "Weight", placeholder: "600" },
  { key: "lineHeight", label: "Line height", placeholder: "1.5" },
  { key: "color", label: "Text color", placeholder: "#111827" },
  { key: "backgroundColor", label: "Background", placeholder: "transparent" },
  { key: "margin", label: "Margin", placeholder: "0 0 12px" },
  { key: "padding", label: "Padding", placeholder: "8px 12px" },
  { key: "borderRadius", label: "Radius", placeholder: "8px" },
  { key: "textAlign", label: "Align", placeholder: "left" },
];

/**
 * Live edits for an annotated element: font, text, spacing and colors are
 * previewed in the page as you type, and sent with the annotation as the
 * change CoWork should make. Closing the panel puts the element back.
 */
export function AdjustPanel({
  taskId,
  sessionId,
  selector,
  computedStyle,
  textQuote,
  canEditText,
  onChange,
  onPreviewed,
}: {
  taskId: string;
  sessionId: string;
  selector: string;
  computedStyle: Record<string, string>;
  textQuote: string;
  canEditText: boolean;
  onChange: (changes: AdjustChanges) => void;
  /** The page now shows the edit (or its revert): a still image of the page is out of date. */
  onPreviewed?: () => void;
}) {
  const initial = useRef<Record<string, string>>({ ...computedStyle, text: textQuote });
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initial.current }));
  const timerRef = useRef<number | null>(null);

  // Put the element back when the panel closes.
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      void window.electronAPI
        .previewBrowserWorkbenchStyle?.({ taskId, sessionId, selector, action: "revert" })
        .catch(() => undefined);
    },
    [selector, sessionId, taskId],
  );

  const update = (key: string, value: string) => {
    const next = { ...values, [key]: value };
    setValues(next);
    const changes: AdjustChanges = { styles: {} };
    const styles: Record<string, string> = {};
    for (const field of FIELDS) {
      const from = initial.current[field.key] || "";
      const to = next[field.key] || "";
      if (to.trim() && to !== from) {
        changes.styles[field.key] = { from, to };
        styles[field.key] = to;
      }
    }
    const textChanged = canEditText && next.text !== initial.current.text;
    if (textChanged) changes.text = { from: initial.current.text || "", to: next.text || "" };
    onChange(changes);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void window.electronAPI
        .previewBrowserWorkbenchStyle?.({
          taskId,
          sessionId,
          selector,
          action: "apply",
          styles,
          text: textChanged ? next.text : undefined,
        })
        .catch(() => undefined)
        .finally(() => onPreviewed?.());
    }, 120);
  };

  return (
    <div className="browser-annotation-adjust">
      {canEditText && (
        <label className="browser-annotation-adjust-text">
          Text
          <textarea
            rows={2}
            value={values.text || ""}
            onChange={(event) => update("text", event.target.value)}
          />
        </label>
      )}
      <div className="browser-annotation-adjust-grid">
        {FIELDS.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              value={values[field.key] || ""}
              placeholder={field.placeholder}
              onChange={(event) => update(field.key, event.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
