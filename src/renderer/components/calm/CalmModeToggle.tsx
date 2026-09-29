import type { InteractionModeSelection } from "../../../shared/interaction-mode";

interface CalmModeToggleProps {
  selection: InteractionModeSelection;
  onChange: (selection: InteractionModeSelection) => void;
  disabled?: boolean;
}

/**
 * Two-way switch between conversation-only help ("Ask") and task work ("Do").
 * "Do" keeps any execution override the user already picked through the
 * advanced mode menu.
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
        title="Discuss or draft using supplied content; no external actions"
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
        title="Work on a task using the tools allowed by your access and approval settings"
      >
        Do
      </button>
    </div>
  );
}
