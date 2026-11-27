export const COMPUTER_USE_TOOL_NAMES = [
  "native_app",
  "screenshot",
  "click",
  "double_click",
  "move_mouse",
  "drag",
  "scroll",
  "type_text",
  "keypress",
  "wait",
] as const;

/** How long a task waits for another task to finish with this computer. */
export const COMPUTER_USE_WAIT_MS = 2 * 60 * 1000;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

const COMPUTER_USE_TOOL_NAME_SET = new Set<string>(COMPUTER_USE_TOOL_NAMES);

export function isComputerUseToolName(toolName: string): toolName is ComputerUseToolName {
  return COMPUTER_USE_TOOL_NAME_SET.has(String(toolName || "").trim());
}

export type BrowserAutomationMode = "background" | "visible" | "ask";
export type NativeComputerUseMode = "background" | "background_first" | "ask_visible" | "visible";

export interface ComputerUseAutomationSettings {
  browserAutomationMode: BrowserAutomationMode;
  nativeComputerUseMode: NativeComputerUseMode;
}

/**
 * An app computer use may control without asking, in sessions the user started. Added when the
 * user answers "Always allow" for it; removed in Settings > Built-in Tools > Computer use.
 */
export interface AlwaysAllowedComputerUseApp {
  /** macOS bundle identifier, such as `com.apple.Safari`. */
  bundleId: string;
  /** The name the approval showed, such as "Safari". */
  name: string;
  addedAt: number;
}

export function normalizeBrowserAutomationMode(value: unknown): BrowserAutomationMode {
  return value === "visible" || value === "ask" ? value : "background";
}

export function normalizeNativeComputerUseMode(value: unknown): NativeComputerUseMode {
  return value === "visible" || value === "ask_visible" ? value : "background";
}
