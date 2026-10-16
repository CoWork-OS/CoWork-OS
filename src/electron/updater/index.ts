import type { BrowserWindow } from "electron";
import { app } from "electron";
import { APP_DISPLAY_NAME } from "../branding";
import { updateManager } from "./update-manager";
import { UpdatePreferencesStore } from "./update-preferences";
import { UpdatePrompt } from "./update-prompt";
import { UpdateWindow } from "./update-window";

export { UpdateManager, updateManager } from "./update-manager";
export { UpdatePreferencesStore } from "./update-preferences";

let prompt: UpdatePrompt | null = null;
let anchorWindow: BrowserWindow | null = null;

/** The app-wide update prompt; the window opens only when there is something to show. */
export function getUpdatePrompt(): UpdatePrompt {
  if (prompt) return prompt;
  const view = new UpdateWindow({
    appName: APP_DISPLAY_NAME,
    getAnchorWindow: () => anchorWindow,
    onAction: (action) => void prompt?.handleAction(action),
    onClosed: () => prompt?.handleClosed(),
  });
  prompt = new UpdatePrompt({
    manager: updateManager,
    preferences: UpdatePreferencesStore,
    view,
    appName: APP_DISPLAY_NAME,
    locale: () => app.getLocale(),
  });
  return prompt;
}

/** The window the prompt centres on. */
export function setUpdatePromptAnchor(window: BrowserWindow): void {
  anchorWindow = window;
}
