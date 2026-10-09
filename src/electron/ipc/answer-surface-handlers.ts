/**
 * Interactive answer surface IPC: the control values a user set in an answer, and the
 * photos a surface asks for by description (see answer-surface-operations.ts).
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import {
  createAnswerSurfaceIpcHandlers,
  type AnswerSurfaceIpcDeps,
} from "../answer-surfaces/answer-surface-operations";
import { registerHtmlSurface } from "../answer-surfaces/html-surface-document";
import { createWebPreviewUrl } from "../media";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";

export function setupAnswerSurfaceHandlers(deps: AnswerSurfaceIpcDeps): void {
  // Every surface in view reads its state once; saves are debounced control changes.
  rateLimiter.configure(IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, RATE_LIMIT_CONFIGS.frequent);
  rateLimiter.configure(IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE, RATE_LIMIT_CONFIGS.frequent);
  rateLimiter.configure(IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES, RATE_LIMIT_CONFIGS.standard);
  const handlers = createAnswerSurfaceIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }

  // Desktop only: the browser host has no cowork-preview:// origin, so its renderer keeps
  // the static srcdoc frame. Each inline HTML surface registers once when it mounts.
  rateLimiter.configure(IPC_CHANNELS.ANSWER_SURFACE_REGISTER_HTML, RATE_LIMIT_CONFIGS.frequent);
  ipcMain.handle(IPC_CHANNELS.ANSWER_SURFACE_REGISTER_HTML, (event, raw: unknown) => {
    // Only the app's own top-level renderer registers surfaces, never a framed page.
    if (event.senderFrame && event.senderFrame.parent !== null) {
      throw new Error("HTML surfaces can only be registered by the app window");
    }
    if (!rateLimiter.check(IPC_CHANNELS.ANSWER_SURFACE_REGISTER_HTML)) {
      throw new Error("Rate limit exceeded. Try again shortly.");
    }
    return registerHtmlSurface(raw, createWebPreviewUrl);
  });
}
