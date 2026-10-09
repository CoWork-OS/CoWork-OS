import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Minus,
  Plus,
  ScanSearch,
  X,
} from "lucide-react";
import "./image-lightbox.css";

type ImageLightboxProps = {
  /** Image source. When empty the lightbox shows a loading state. */
  src?: string;
  fileName?: string;
  alt?: string;
  /** Secondary line under the file name, e.g. "PNG · 520×574 · 156 KB". */
  meta?: string;
  onClose: () => void;
  onShowInFinder?: () => void;
  onOpenExternal?: () => void;
};

type Offset = { x: number; y: number };

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Index of the element Tab should move to so focus stays inside the dialog, or null when the
 * browser's default order already does. `currentIndex` is -1 when focus is outside the list.
 */
export function resolveFocusTrapIndex(
  count: number,
  currentIndex: number,
  backwards: boolean,
): number | null {
  if (count === 0) return null;
  if (currentIndex < 0) return backwards ? count - 1 : 0;
  if (backwards && currentIndex === 0) return count - 1;
  if (!backwards && currentIndex === count - 1) return 0;
  return null;
}

/**
 * Full-viewport image viewer: dimmed, blurred backdrop with the image floating
 * borderless in the middle. Supports wheel/pinch zoom toward the cursor,
 * drag-to-pan while zoomed, double-click to toggle zoom, and keyboard shortcuts
 * (Esc close, +/- zoom, 0 reset).
 */
export function ImageLightbox({
  src,
  fileName,
  alt,
  meta,
  onClose,
  onShowInFinder,
  onOpenExternal,
}: ImageLightboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origin: Offset; moved: boolean } | null>(
    null,
  );
  const copyTimerRef = useRef<number | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const label = fileName || alt || "Image";

  // Mirror of `scale` so event handlers can compute the next zoom without stale closures.
  const scaleRef = useRef(1);

  const resetView = useCallback(() => {
    scaleRef.current = 1;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetView();
    setNatural(null);
  }, [src, resetView]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Move focus into the dialog while it is open and hand it back to the opener on close.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  /** Zoom to `nextScale`, keeping the point under (clientX, clientY) stationary. */
  const zoomTo = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const prevScale = scaleRef.current;
    const target = clampScale(nextScale);
    if (target === prevScale) return;
    scaleRef.current = target;
    setScale(target);
    if (target === MIN_SCALE) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    const stage = stageRef.current;
    if (stage && clientX !== undefined && clientY !== undefined) {
      const rect = stage.getBoundingClientRect();
      const cx = clientX - (rect.left + rect.width / 2);
      const cy = clientY - (rect.top + rect.height / 2);
      setOffset((prev) => ({
        x: cx - ((cx - prev.x) * target) / prevScale,
        y: cy - ((cy - prev.y) * target) / prevScale,
      }));
    } else {
      setOffset((prev) => ({
        x: (prev.x * target) / prevScale,
        y: (prev.y * target) / prevScale,
      }));
    }
  }, []);

  /** Scale at which the image is shown at its natural pixel size. */
  const actualSizeScale = useCallback(() => {
    const img = imgRef.current;
    if (!img || !natural || img.offsetWidth === 0) return 1;
    return natural.width / img.offsetWidth;
  }, [natural]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const root = rootRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((element) => element.getClientRects().length > 0);
        if (focusables.length === 0) {
          event.preventDefault();
          root.focus({ preventScroll: true });
          return;
        }
        const active = document.activeElement as HTMLElement | null;
        const next = resolveFocusTrapIndex(
          focusables.length,
          active ? focusables.indexOf(active) : -1,
          event.shiftKey,
        );
        if (next !== null) {
          event.preventDefault();
          focusables[next].focus();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomTo(scaleRef.current * ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomTo(scaleRef.current / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, resetView, zoomTo]);

  // Wheel needs a non-passive listener so we can stop the page from scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (!src) return;
      event.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels use larger ones.
      const intensity = event.ctrlKey ? 0.01 : 0.002;
      const factor = Math.exp(-event.deltaY * intensity);
      zoomTo(scaleRef.current * factor, event.clientX, event.clientY);
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [src, zoomTo]);

  const handlePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0 || scale <= MIN_SCALE) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origin: offset,
      moved: false,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setOffset({ x: drag.origin.x + dx, y: drag.origin.y + dy });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLImageElement>) => {
    if (scale > MIN_SCALE) {
      resetView();
      return;
    }
    // Zoom to actual pixels when the image was downscaled, otherwise 2x.
    const actual = actualSizeScale();
    zoomTo(actual > 1.05 ? actual : 2, event.clientX, event.clientY);
  };

  const handleCopyImage = async () => {
    if (!src) return;
    try {
      const blob = await (await fetch(src)).blob();
      const pngBlob = blob.type === "image/png" ? blob : await convertToPng(blob).catch(() => null);
      if (!pngBlob) throw new Error("Unsupported image format");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("Failed to copy image:", err);
    }
  };

  const zoomPercent = (() => {
    const img = imgRef.current;
    if (!img || !natural || img.offsetWidth === 0) return Math.round(scale * 100);
    return Math.round(((img.offsetWidth * scale) / natural.width) * 100);
  })();

  const metaLine = meta || (natural ? `${natural.width}×${natural.height}` : "");

  return createPortal(
    <div
      ref={rootRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(event) => {
        // The portal still bubbles through the React tree, e.g. to a markdown link around the image.
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="image-lightbox-topbar" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-title">
          <span className="image-lightbox-filename" title={label}>
            {label}
          </span>
          {metaLine && <span className="image-lightbox-meta">{metaLine}</span>}
        </div>
        <div className="image-lightbox-actions">
          {src && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={handleCopyImage}
              title={copied ? "Copied" : "Copy image"}
              aria-label="Copy image"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          )}
          {src && (
            <a
              className="image-lightbox-btn"
              href={src}
              download={fileName || "image.png"}
              title="Download"
              aria-label={`Download ${label}`}
            >
              <Download size={16} />
            </a>
          )}
          {onShowInFinder && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={onShowInFinder}
              title="Show in Finder"
              aria-label="Show in Finder"
            >
              <FolderOpen size={16} />
            </button>
          )}
          {onOpenExternal && (
            <button
              type="button"
              className="image-lightbox-btn"
              onClick={onOpenExternal}
              title="Open in default app"
              aria-label="Open in default app"
            >
              <ExternalLink size={16} />
            </button>
          )}
          <span className="image-lightbox-divider" aria-hidden="true" />
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close image viewer"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="image-lightbox-stage" ref={stageRef}>
        {src ? (
          <img
            ref={imgRef}
            src={src}
            alt={alt || label}
            className="image-lightbox-img"
            data-zoomed={scale > MIN_SCALE ? "true" : undefined}
            data-dragging={dragging ? "true" : undefined}
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                setNatural({ width: img.naturalWidth, height: img.naturalHeight });
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ) : (
          <div className="image-lightbox-spinner" aria-label="Loading image" />
        )}
      </div>

      {src && (
        <div className="image-lightbox-zoombar" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={() => zoomTo(scale / ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
            title="Zoom out (-)"
            aria-label="Zoom out"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="image-lightbox-zoom-label"
            onClick={resetView}
            title="Fit to screen (0)"
            aria-label="Fit to screen"
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={() => zoomTo(scale * ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            <Plus size={15} />
          </button>
          <span className="image-lightbox-divider" aria-hidden="true" />
          <button
            type="button"
            className="image-lightbox-btn"
            onClick={() => {
              const actual = actualSizeScale();
              if (actual > 1.05) zoomTo(actual);
            }}
            title="Actual size"
            aria-label="Actual size"
          >
            <ScanSearch size={15} />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

async function convertToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("Encode failed"))), "image/png"),
  );
}
