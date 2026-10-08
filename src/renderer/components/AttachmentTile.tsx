import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { ImageLightbox } from "./ImageLightbox";
import { formatFileSize } from "./MainContent/attachments";
import "./attachment-tile.css";

export type AttachmentTileFile = {
  name: string;
  size: number;
  mimeType?: string;
  /** Raw base64 bytes (no data: prefix), present for pasted/dropped files. */
  dataBase64?: string;
  /** OS-rendered preview from the file picker, present for picked files. */
  thumbnailDataUrl?: string;
};

type AttachmentTileProps = {
  attachment: AttachmentTileFile;
  onRemove: () => void;
  disabled?: boolean;
};

type FileKind = "image" | "pdf" | "doc" | "sheet" | "slides" | "archive" | "code" | "text" | "file";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"]);
const KIND_BY_EXT: Record<string, FileKind> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  pages: "doc",
  odt: "doc",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ods: "sheet",
  ppt: "slides",
  pptx: "slides",
  key: "slides",
  odp: "slides",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  rar: "archive",
  "7z": "archive",
  md: "text",
  txt: "text",
  log: "text",
  json: "code",
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  py: "code",
  html: "code",
  css: "code",
  sh: "code",
  yaml: "code",
  yml: "code",
  sql: "code",
};

const PDF_THUMBNAIL_WIDTH = 160;

const getExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const getFileKind = (name: string, mimeType?: string): FileKind => {
  const ext = getExtension(name);
  if (mimeType?.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (mimeType === "application/pdf") return "pdf";
  return KIND_BY_EXT[ext] ?? "file";
};

const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Renders the first page of a PDF to a small PNG data URL. */
async function renderPdfFirstPage(dataBase64: string): Promise<string | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url,
  ).toString();
  const loadingTask = pdfjs.getDocument({ data: base64ToUint8Array(dataBase64) });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_THUMBNAIL_WIDTH / baseViewport.width });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Composer attachment preview. Images show as a square thumbnail that opens the
 * lightbox; other files show as a card with a first-page/OS thumbnail when one
 * is available, or a colored file-type badge otherwise.
 */
export function AttachmentTile({ attachment, onRemove, disabled }: AttachmentTileProps) {
  const { name, size, mimeType, dataBase64, thumbnailDataUrl } = attachment;
  const kind = getFileKind(name, mimeType);
  const ext = getExtension(name);
  const [pdfThumbnail, setPdfThumbnail] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const fullImageSrc = useMemo(() => {
    if (kind !== "image" || !dataBase64) return null;
    const type = mimeType?.startsWith("image/") ? mimeType : "image/png";
    return `data:${type};base64,${dataBase64}`;
  }, [kind, dataBase64, mimeType]);

  // Pasted/dropped PDFs have no OS thumbnail; render the first page ourselves.
  useEffect(() => {
    setPdfThumbnail(null);
    if (kind !== "pdf" || thumbnailDataUrl || !dataBase64) return;
    let cancelled = false;
    renderPdfFirstPage(dataBase64)
      .then((url) => {
        if (!cancelled) setPdfThumbnail(url);
      })
      .catch(() => {
        // Fall back to the file-type badge.
      });
    return () => {
      cancelled = true;
    };
  }, [kind, dataBase64, thumbnailDataUrl]);

  const previewSrc = fullImageSrc || thumbnailDataUrl || pdfThumbnail;
  const sizeLabel = size > 0 ? formatFileSize(size) : "";

  const removeButton = (
    <button
      type="button"
      className="attachment-tile-remove"
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
      disabled={disabled}
      title="Remove attachment"
      aria-label={`Remove ${name}`}
    >
      <X size={11} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );

  if (kind === "image" && previewSrc) {
    const canExpand = Boolean(fullImageSrc);
    return (
      <div className="attachment-tile attachment-tile-image" title={`${name} · ${sizeLabel}`}>
        <button
          type="button"
          className="attachment-tile-image-button"
          onClick={() => canExpand && setLightboxOpen(true)}
          disabled={!canExpand}
          aria-label={canExpand ? `Preview ${name}` : name}
        >
          <img src={previewSrc} alt={name} draggable={false} />
        </button>
        {removeButton}
        {lightboxOpen && fullImageSrc && (
          <ImageLightbox
            src={fullImageSrc}
            fileName={name}
            meta={sizeLabel}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </div>
    );
  }

  const typeLabel = (ext || kind).toUpperCase().slice(0, 5);

  return (
    <div className="attachment-tile attachment-tile-file" title={name}>
      <span className="attachment-tile-thumb" data-kind={kind}>
        {previewSrc ? (
          <img src={previewSrc} alt="" draggable={false} />
        ) : (
          <span className="attachment-tile-badge">{typeLabel}</span>
        )}
      </span>
      <span className="attachment-tile-text">
        <span className="attachment-tile-name">{name}</span>
        <span className="attachment-tile-meta">
          {[typeLabel, sizeLabel].filter(Boolean).join(" · ")}
        </span>
      </span>
      {removeButton}
    </div>
  );
}
