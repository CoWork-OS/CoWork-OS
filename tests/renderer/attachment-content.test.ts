import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_CONTENT_START_MARKER,
  ATTACHMENT_CONTENT_END_MARKER,
  MAX_EXTRACTED_ATTACHMENT_CHARS,
  buildImageAttachmentViewerOptions,
  shouldRequestImageOcr,
  stripHtmlForText,
  stripPptxBubbleContent,
  truncateTextForTaskPrompt,
} from '../../src/renderer/components/utils/attachment-content';

describe('attachment-content utilities', () => {
  it('should request image OCR only for image-related prompts', () => {
    expect(shouldRequestImageOcr('Can you read the text from the image?', 'screenshot.png')).toBe(true);
    expect(shouldRequestImageOcr('Summarize this document', 'slides.pptx')).toBe(false);
  });

  it('should build lightweight image attachment options', () => {
    expect(buildImageAttachmentViewerOptions('Read the text from the image', 'image.png')).toEqual({
      enableImageOcr: true,
      imageOcrMaxChars: 6000,
      includeImageContent: true,
    });

    expect(buildImageAttachmentViewerOptions('Review file', 'notes.txt')).toEqual({
      enableImageOcr: false,
      imageOcrMaxChars: 6000,
      includeImageContent: false,
    });
  });

  it('should strip HTML for text extraction', () => {
    expect(stripHtmlForText('<p>Hello</p><br/>world&nbsp;'))
      .toBe('Hello\n\nworld');
  });

  it('should truncate long text for task prompts', () => {
    const longText = 'x'.repeat(MAX_EXTRACTED_ATTACHMENT_CHARS + 3);
    expect(truncateTextForTaskPrompt(longText)).toContain(`[... excerpt truncated to first ${MAX_EXTRACTED_ATTACHMENT_CHARS} characters ...]`);
  });

  it('should remove attachment extracted section from chat bubble rendering', () => {
    const message = `User question\n${ATTACHMENT_CONTENT_START_MARKER}\n  Extracted content:\n  line one\n${ATTACHMENT_CONTENT_END_MARKER}\nMore details`;
    expect(stripPptxBubbleContent(message)).toBe('User question\nMore details');
  });
});
