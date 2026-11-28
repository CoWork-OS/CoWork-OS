/**
 * Registers the dictation shortcut while it is turned on (macOS only) and wires the
 * controller to Electron: the overlay, the microphone permission, the speech-to-text
 * provider from Settings > Voice, and the clipboard paste.
 */
import { ClipboardItem, clipboard, globalShortcut, systemPreferences } from "electron";
import { checkAccessibilityTrusted } from "../computer-use/computer-use-permissions";
import { createLogger } from "../utils/logger";
import { getVoiceService } from "../voice/VoiceService";
import { DictationController, type DictationDeps } from "./dictation-controller";
import { DictationOverlay } from "./dictation-overlay";
import {
  deliverDictation,
  postPasteKeystroke,
  readFrontmostApp,
  readPasteboardChangeCount,
  type ClipboardAccess,
} from "./paste-into-front-app";

const logger = createLogger("Dictation");

/** Control+Shift+Space: free in macOS itself, and apart from Quick task's Cmd+Shift+Space. */
export const DICTATION_ACCELERATOR = "Control+Shift+Space";
const CANCEL_ACCELERATOR = "Escape";

/** nspasteboard.org marker that asks clipboard managers not to keep an entry. */
const TRANSIENT_FORMAT = 'electron application/osclipboard;format="org.nspasteboard.TransientType"';

const electronClipboard: ClipboardAccess = {
  read: () => clipboard.read(),
  write: (snapshot) => clipboard.write(snapshot.map((entry) => new ClipboardItem(entry))),
  readText: () => clipboard.readText(),
  writeText: async (text, options) => {
    if (options?.transient) {
      try {
        await clipboard.write([new ClipboardItem({ "text/plain": text, [TRANSIENT_FORMAT]: "" })]);
        return;
      } catch {
        // Fall back to plain text.
      }
    }
    await clipboard.writeText(text);
  },
  clear: () => clipboard.clear(),
  changeCount: () => readPasteboardChangeCount(),
};

async function microphoneAccess(): Promise<"granted" | "denied"> {
  if (process.platform !== "darwin") return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  return "denied";
}

export class DictationShortcut {
  private registered = false;
  private cancelKeyRegistered = false;
  private overlay: DictationOverlay | null = null;
  private controller: DictationController | null = null;

  /** Register or unregister to match the setting. */
  apply(enabled: boolean): void {
    if (process.platform !== "darwin") return;
    if (enabled && !this.registered) {
      try {
        this.registered = globalShortcut.register(DICTATION_ACCELERATOR, () => {
          void this.getController().toggle();
        });
        if (!this.registered) logger.warn(`${DICTATION_ACCELERATOR} is in use by another app`);
      } catch (error) {
        logger.warn("Could not register the dictation shortcut:", error);
      }
    } else if (!enabled && this.registered) {
      this.dispose();
    }
  }

  dispose(): void {
    void this.controller?.cancel();
    this.setCancelKey(false);
    if (this.registered) {
      try {
        globalShortcut.unregister(DICTATION_ACCELERATOR);
      } catch {
        // The app is quitting or the shortcut is already gone.
      }
      this.registered = false;
    }
    this.overlay?.destroy();
    this.overlay = null;
    this.controller = null;
  }

  private getController(): DictationController {
    if (this.controller) return this.controller;
    const overlay = new DictationOverlay((action) => {
      if (action === "finish") void this.controller?.finish();
      else void this.controller?.cancel();
    });
    const deps: DictationDeps = {
      overlay,
      microphoneAccess,
      transcriptionReady: () => getVoiceService().isTranscriptionAvailable(),
      // force: the shortcut is its own consent to speech-to-text, whether or not voice
      // mode is on. quiet: the text goes only to the app in front, never to CoWork's window.
      transcribe: (audio) => getVoiceService().transcribe(audio, { force: true, quiet: true }),
      frontmostApp: readFrontmostApp,
      deliver: (text, options) =>
        deliverDictation(
          text,
          {
            clipboard: electronClipboard,
            accessibilityTrusted: (prompt) => checkAccessibilityTrusted(prompt),
            postPaste: postPasteKeystroke,
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: (message) => logger.warn(message),
          },
          options,
        ),
      setCancelKey: (active) => this.setCancelKey(active),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      log: (message) => logger.info(message),
    };
    this.overlay = overlay;
    this.controller = new DictationController(deps);
    return this.controller;
  }

  /** Escape belongs to the app in front except while dictation is under way. */
  private setCancelKey(active: boolean): void {
    if (active && !this.cancelKeyRegistered) {
      try {
        this.cancelKeyRegistered = globalShortcut.register(CANCEL_ACCELERATOR, () => {
          void this.controller?.cancel();
        });
      } catch (error) {
        logger.warn("Could not register Escape for dictation:", error);
      }
    } else if (!active && this.cancelKeyRegistered) {
      try {
        globalShortcut.unregister(CANCEL_ACCELERATOR);
      } catch {
        // Already gone.
      }
      this.cancelKeyRegistered = false;
    }
  }
}
