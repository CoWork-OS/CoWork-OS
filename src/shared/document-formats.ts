const WORD_DOCUMENT_ARTIFACT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
  ".doc",
  ".rtf",
  ".odt",
  ".ott",
  ".pages",
]);

const IN_APP_DOCUMENT_PREVIEW_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
  ".doc",
  ".rtf",
  ".odt",
  ".ott",
]);

const EDITABLE_DOCUMENT_EXTENSIONS = new Set([".docx"]);

const WORD_DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/rtf",
  "text/markdown",
  "text/x-markdown",
  "application/vnd.apple.pages",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroenabled.12",
  "text/rtf",
]);

export function getDocumentFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const match = /\.([^.]+)$/.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function getDocumentFormatLabel(filePath: string): string {
  const extension = getDocumentFileExtension(filePath);
  switch (extension) {
    case ".md":
      return "MD";
    case ".markdown":
      return "Markdown";
    case ".docx":
      return "DOCX";
    case ".docm":
      return "DOCM";
    case ".dotx":
      return "DOTX";
    case ".dotm":
      return "DOTM";
    case ".doc":
      return "DOC";
    case ".rtf":
      return "RTF";
    case ".odt":
      return "ODT";
    case ".ott":
      return "OTT";
    case ".pages":
      return "Pages";
    default:
      return "Document";
  }
}

export function isWordDocumentArtifactFile(filePath: string): boolean {
  return WORD_DOCUMENT_ARTIFACT_EXTENSIONS.has(getDocumentFileExtension(filePath));
}

export function canPreviewDocumentInApp(filePath: string): boolean {
  return IN_APP_DOCUMENT_PREVIEW_EXTENSIONS.has(getDocumentFileExtension(filePath));
}

export function canEditDocumentInApp(filePath: string): boolean {
  return EDITABLE_DOCUMENT_EXTENSIONS.has(getDocumentFileExtension(filePath));
}

export function isWordDocumentMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return WORD_DOCUMENT_MIME_TYPES.has(normalized);
}
