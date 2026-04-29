const WEB_PAGE_EXTENSIONS = new Set([".html", ".htm"]);

const HTML_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
]);

export function getWebPageFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const match = /\.([^.]+)$/.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function getWebPageFormatLabel(filePath: string): string {
  const extension = getWebPageFileExtension(filePath);
  if (extension === ".htm") return "HTM";
  if (extension === ".html") return "HTML";
  return "Web";
}

export function isWebPageArtifactFile(filePath: string): boolean {
  return WEB_PAGE_EXTENSIONS.has(getWebPageFileExtension(filePath));
}

export function canPreviewWebPageInApp(filePath: string): boolean {
  return isWebPageArtifactFile(filePath);
}

export function isWebPageMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return HTML_MIME_TYPES.has(normalized);
}
