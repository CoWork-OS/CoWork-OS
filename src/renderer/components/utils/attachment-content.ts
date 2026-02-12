const MAX_EXTRACTED_ATTACHMENT_CHARS = 6000;
const MAX_IMAGE_OCR_CHARS = 6000;
const ATTACHMENT_CONTENT_START_MARKER = '[[ATTACHMENT_EXTRACTED_CONTENT_START]]';
const ATTACHMENT_CONTENT_END_MARKER = '[[ATTACHMENT_EXTRACTED_CONTENT_END]]';

const OCR_REQUEST_PATTERNS = [
  /\bocr\b/i,
  /\bextract\s+(?:any|all)?\s*text\s+(?:from|in|on)?\s*(?:the\s+)?(image|photo|screenshot|diagram|chart|presentation)\b/i,
  /\bread\s+(?:the\s+)?(?:text|content)\s+(?:from|in|on)?\s*(?:the\s+)?(image|photo|screenshot|diagram|chart|figure|slide)\b/i,
  /\bscan(?:ning)?\b.*\b(?:image|photo|screenshot|diagram|chart|figure)\b/i,
  /\bimage\s+(?:contains?|has)\s+(?:text|numbers?|labels?)\b/i,
  /\bimage\s+(?:text|diagram|chart|screenshot)\b/i,
  /\btranscribe\s+(?:text|content)\s+(?:from|in|on)?\s+(?:an?\s+)?(image|photo|screenshot|diagram|chart|figure|slide)\b/i,
  /\bopen\s+the\s+image\s+and\s+(?:analy|analyze|interpret|read)\b/i,
];

const shouldRequestImageOcr = (prompt: string, fileName: string): boolean => {
  const combined = `${prompt} ${fileName}`.toLowerCase();
  return OCR_REQUEST_PATTERNS.some((pattern) => pattern.test(combined));
};

const stripHtmlForText = (value: string): string =>
  value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();

const truncateTextForTaskPrompt = (value: string): string => {
  if (value.length <= MAX_EXTRACTED_ATTACHMENT_CHARS) return value.trim();
  return `${value.slice(0, MAX_EXTRACTED_ATTACHMENT_CHARS)}\n\n[... excerpt truncated to first ${MAX_EXTRACTED_ATTACHMENT_CHARS} characters ...]`;
};

const stripPptxBubbleContent = (value: string): string => {
  const lines = value.split('\n');
  const output: string[] = [];
  let inExtractedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === ATTACHMENT_CONTENT_START_MARKER) {
      inExtractedSection = true;
      continue;
    }

    if (trimmed === ATTACHMENT_CONTENT_END_MARKER) {
      inExtractedSection = false;
      continue;
    }

    if (trimmed === 'Extracted content:' || trimmed === 'Attachment content:') {
      inExtractedSection = true;
      continue;
    }

    if (inExtractedSection) {
      if (trimmed === '' || /^\s{2,}/.test(line) || line.startsWith('\t')) {
        continue;
      }
      inExtractedSection = false;
      continue;
    }

    output.push(line);
  }

  return output.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const buildImageAttachmentViewerOptions = (inputText: string, fileName: string) => {
  const shouldRunOcr = shouldRequestImageOcr(inputText, fileName);
  return {
    enableImageOcr: shouldRunOcr,
    imageOcrMaxChars: MAX_IMAGE_OCR_CHARS,
    includeImageContent: shouldRunOcr,
  };
};

export {
  ATTACHMENT_CONTENT_START_MARKER,
  ATTACHMENT_CONTENT_END_MARKER,
  MAX_EXTRACTED_ATTACHMENT_CHARS,
  MAX_IMAGE_OCR_CHARS,
  OCR_REQUEST_PATTERNS,
  buildImageAttachmentViewerOptions,
  shouldRequestImageOcr,
  stripHtmlForText,
  stripPptxBubbleContent,
  truncateTextForTaskPrompt,
};
