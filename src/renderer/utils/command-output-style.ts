import { COMMAND_OUTPUT_STYLES, type CommandOutputStyle } from "../../shared/types";

/** DOM event broadcast when the command output style preference changes. */
export const COMMAND_OUTPUT_STYLE_CHANGED_EVENT = "cowork:command-output-style-changed";

const STORAGE_KEY = "commandOutputStyle";

export const DEFAULT_COMMAND_OUTPUT_STYLE: CommandOutputStyle = "terminal";

export function isCommandOutputStyle(value: unknown): value is CommandOutputStyle {
  return COMMAND_OUTPUT_STYLES.includes(value as CommandOutputStyle);
}

/** Cached preference, so the first render matches the persisted setting. */
export function readCommandOutputStyle(): CommandOutputStyle {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isCommandOutputStyle(stored) ? stored : DEFAULT_COMMAND_OUTPUT_STYLE;
  } catch {
    return DEFAULT_COMMAND_OUTPUT_STYLE;
  }
}

/** Cache the preference and notify open views so the change applies immediately. */
export function publishCommandOutputStyle(style: CommandOutputStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(COMMAND_OUTPUT_STYLE_CHANGED_EVENT, { detail: style }));
}
