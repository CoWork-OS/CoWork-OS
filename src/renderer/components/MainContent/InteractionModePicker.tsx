import { ListTodo, MessageCircle, Sparkles } from "lucide-react";
import type { InteractionModeSelection } from "../../../shared/interaction-mode";

export function interactionModeLabel(selection: InteractionModeSelection): string {
  if (selection.mode === "chat") return "Ask";
  return selection.executionOverride === "plan" ? "Plan" : "Do";
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
  const isDo = selection.mode === "smart" && !selection.executionOverride;
  const isPlan = selection.mode === "smart" && selection.executionOverride === "plan";
  const isAsk = selection.mode === "chat";
  const Icon = isAsk ? MessageCircle : isPlan ? ListTodo : Sparkles;
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
        <div className="input-status-mode-dropdown" role="menu" aria-label="Work mode">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isDo}
            className={`input-status-mode-option ${isDo ? "active" : ""}`}
            title="Work on the task using the tools allowed by your access and approval settings"
            onClick={() => onChange({ mode: "smart" })}
          >
            <Sparkles size={14} aria-hidden />
            Do
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isAsk}
            className={`input-status-mode-option ${isAsk ? "active" : ""}`}
            title="Discuss or draft using your conversation and supplied content; no external actions"
            onClick={() => onChange({ mode: "chat" })}
          >
            <MessageCircle size={14} aria-hidden />
            Ask
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isPlan}
            className={`input-status-mode-option ${isPlan ? "active" : ""}`}
            title="Plan the work without mutating tools; can ask structured questions before anything runs"
            onClick={() => onChange({ mode: "smart", executionOverride: "plan" })}
          >
            <ListTodo size={14} aria-hidden />
            Plan
          </button>
        </div>
      )}
    </>
  );
}
