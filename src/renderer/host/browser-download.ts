/** Download bytes through a connected, explicitly-named Blob link. The
 * octet-stream wrapper keeps HTML/SVG payloads from opening as active pages. */
export function triggerBrowserBlobDownload(blob: Blob, fileName: string): void {
  const safeName = fileName.replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 240) || "download";
  const downloadBlob = new Blob([blob], { type: "application/octet-stream" });
  const objectUrl = URL.createObjectURL(downloadBlob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = safeName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser finish consuming the Blob before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}
