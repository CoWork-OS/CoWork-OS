import type { InteractionModeSelection } from "../../../shared/interaction-mode";

interface CalmModeToggleProps {
  selection: InteractionModeSelection;
  onChange: (selection: InteractionModeSelection) => void;
  disabled?: boolean;
}

/**
 * Two-way switch between a quick conversational answer ("Ask") and a task the
 * agent carries out end to end ("Do"). "Do" keeps any execution override the
 * user already picked through the advanced mode menu.
 */
export function CalmModeToggle({ selection, onChange, disabled }: CalmModeToggleProps) {
  const isAsk = selection.mode === "chat";
  return (
    <div className="calm-segmented calm-mode-toggle" role="radiogroup" aria-label="Work mode">
      <button
        type="button"
        role="radio"
        aria-checked={isAsk}
        className={isAsk ? "active" : ""}
        disabled={disabled}
        onClick={() => onChange({ mode: "chat" })}
        title="Quick answers, lookups and drafts"
      >
        Ask
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!isAsk}
        className={!isAsk ? "active" : ""}
        disabled={disabled}
        onClick={() => {
          if (isAsk) onChange({ mode: "smart" });
        }}
        title="Hand off a task and get a finished result"
      >
        Do
      </button>
    </div>
  );
}
