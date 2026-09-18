import { useState } from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import type { InteractionModeSelection } from "../../../shared/interaction-mode";
import { EXECUTION_MODE_LABEL, EXECUTION_MODE_HINT, EXECUTION_MODE_ORDER } from "./focused-cards";

export function interactionModeLabel(selection: InteractionModeSelection): string {
  return selection.mode === "chat"
    ? "Chat"
    : selection.executionOverride
      ? `Smart · ${EXECUTION_MODE_LABEL[selection.executionOverride]}`
      : "Smart";
}

export function InteractionModePicker({
  selection,
  onChange,
  open,
  onToggle,
}: {
  selection: InteractionModeSelection;
  onChange: (selection: InteractionModeSelection) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const Icon = selection.mode === "chat" ? MessageCircle : Sparkles;
  return (
    <>
      <button
        type="button"
        className="input-status-mode menu-tooltip-target"
        onClick={onToggle}
        title="Applies to your next message"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon size={12} aria-hidden />
        {interactionModeLabel(selection)}
      </button>
      {open && (
        <div className="input-status-mode-dropdown" role="menu" aria-label="Interaction mode">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selection.mode === "smart" && !selection.executionOverride}
            className={`input-status-mode-option ${selection.mode === "smart" && !selection.executionOverride ? "active" : ""}`}
            title="Adapts to your request under the current permissions"
            onClick={() => onChange({ mode: "smart" })}
          >
            <Sparkles size={14} aria-hidden />
            Smart
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selection.mode === "chat"}
            className={`input-status-mode-option ${selection.mode === "chat" ? "active" : ""}`}
            title="Discuss and draft using your conversation and attachments; no external actions"
            onClick={() => onChange({ mode: "chat" })}
          >
            <MessageCircle size={14} aria-hidden />
            Chat
          </button>
          <button
            type="button"
            role="menuitem"
            className="input-status-mode-option"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            Advanced…
          </button>
          {advanced &&
            EXECUTION_MODE_ORDER.filter((value) => value !== "chat").map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                title={EXECUTION_MODE_HINT[value]}
                aria-checked={selection.mode === "smart" && selection.executionOverride === value}
                className={`input-status-mode-option ${selection.mode === "smart" && selection.executionOverride === value ? "active" : ""}`}
                onClick={() => onChange({ mode: "smart", executionOverride: value })}
              >
                {EXECUTION_MODE_LABEL[value]}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
