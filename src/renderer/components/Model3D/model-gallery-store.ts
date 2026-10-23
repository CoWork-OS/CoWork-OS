import { useEffect, useState } from "react";
import { LiveFrameSlots } from "../../utils/live-frame-slots";

/**
 * 3D cards in a conversation share these slots: each live card holds a WebGL context, and
 * Chromium drops the oldest past about 16. Cards on screen win, then the ones used last.
 */
export const MODEL_VIEWER_SLOTS = new LiveFrameSlots(4);

export interface ModelGalleryRequest {
  /** Open with this model selected. */
  path?: string;
  workspacePath?: string;
  taskId?: string;
  title?: string;
}

type Listener = (request: ModelGalleryRequest | null) => void;
const listeners = new Set<Listener>();
let current: ModelGalleryRequest | null = null;

export function openModelGallery(request: ModelGalleryRequest = {}): void {
  current = request;
  listeners.forEach((listener) => listener(current));
}

export function closeModelGallery(): void {
  current = null;
  listeners.forEach((listener) => listener(null));
}

/** The open gallery request, or null while the gallery is closed. */
export function useModelGalleryRequest(): ModelGalleryRequest | null {
  const [request, setRequest] = useState<ModelGalleryRequest | null>(current);
  useEffect(() => {
    listeners.add(setRequest);
    return () => {
      listeners.delete(setRequest);
    };
  }, []);
  return request;
}
