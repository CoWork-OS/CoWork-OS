import type { WindowCaptureResult } from "../../shared/types";
import type { PendingAttachment } from "../components/MainContent/attachments";

type CapturedWindow = Extract<WindowCaptureResult, { ok: true }>;

/** A captured window waiting for the open composer; `id` tells one capture from the next. */
export interface WindowCaptureRequest {
  id: number;
  attachments: PendingAttachment[];
}

/** A file name from the app and window title, safe on every file system. */
export function windowCaptureFileStem(result: Pick<CapturedWindow, "appName" | "windowTitle">) {
  const raw = [result.appName, result.windowTitle].filter(Boolean).join(" - ");
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return safe || "Window";
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * The composer attachments for a captured window: its picture and a short Markdown note with
 * the app, window title, page address and any text read from the picture.
 */
export function windowCaptureAttachments(result: CapturedWindow): PendingAttachment[] {
  const stem = windowCaptureFileStem(result);
  const id = `window-capture-${result.capturedAt}`;
  const noteBase64 = utf8ToBase64(result.note);
  return [
    {
      id: `${id}-image`,
      name: `${stem}.png`,
      size: base64ByteLength(result.imageBase64),
      mimeType: "image/png",
      dataBase64: result.imageBase64,
    },
    {
      id: `${id}-note`,
      name: `${stem}.md`,
      size: base64ByteLength(noteBase64),
      mimeType: "text/markdown",
      dataBase64: noteBase64,
    },
  ];
}
