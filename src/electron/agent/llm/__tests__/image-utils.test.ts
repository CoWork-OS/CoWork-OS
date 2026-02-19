import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  guessImageMimeType,
  isSupportedImageFile,
  loadImageFromFile,
  validateImageForProvider,
  stripImagesForUnsupportedProvider,
  estimateImageTokens,
  createImageContent,
} from '../image-utils';
import { LLMMessage } from '../types';

describe('image-utils', () => {
  it('accepts supported provider-image combinations', () => {
    const image = createImageContent('aGVsbG8=', 'image/jpeg');
    expect(validateImageForProvider(image, 'openai')).toBeNull();
    expect(validateImageForProvider(image, 'openai-compatible')).toBeNull();
  });

  it('rejects unsupported providers', () => {
    const image = createImageContent('aGVsbG8=', 'image/jpeg');
    expect(validateImageForProvider(image, 'groq')).toMatch(/does not support inline images/i);
  });

  it('falls back unsupported image blocks to text', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'image',
            data: 'aGVsbG8=',
            mimeType: 'image/png',
            originalSizeBytes: 900_000,
          },
        ],
      },
    ];

    const converted = stripImagesForUnsupportedProvider(messages, 'groq');
    expect(converted).toHaveLength(1);
    expect(converted[0].content).toMatchObject([
      { type: 'text', text: 'before' },
      { type: 'text', text: expect.stringContaining('[Image attached: image/png') },
    ]);
  });

  it('guesses image MIME type from supported file paths', () => {
    expect(guessImageMimeType('/tmp/example.jpeg')).toBe('image/jpeg');
    expect(guessImageMimeType('/tmp/example.webp')).toBe('image/webp');
    expect(guessImageMimeType('/tmp/example.txt')).toBeNull();
  });

  it('loads supported image files from disk', async () => {
    const tempPath = path.join(os.tmpdir(), `cowork-image-test-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    try {
      await fs.writeFile(tempPath, pngBytes);
      const image = await loadImageFromFile(tempPath);
      expect(image.type).toBe('image');
      expect(image.mimeType).toBe('image/png');
      expect(image.originalSizeBytes).toBe(pngBytes.length);
      expect(typeof image.data).toBe('string');
      expect(image.data.length).toBeGreaterThan(0);
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  });

  it('rejects unsupported image formats from disk', async () => {
    const tempPath = path.join(os.tmpdir(), `cowork-image-test-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    try {
      await fs.writeFile(tempPath, 'not an image');
      await expect(loadImageFromFile(tempPath)).rejects.toThrow('Unsupported image format: .txt');
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  });

  it('tracks provider-supported file extension preferences', () => {
    expect(isSupportedImageFile('/tmp/photo.png')).toBe(true);
    expect(isSupportedImageFile('/tmp/document.txt')).toBe(false);
  });

  it('tracks token bucket thresholds', () => {
    const mb1 = createImageContent('a'.repeat(1024), 'image/png');
    mb1.originalSizeBytes = 300_000;
    expect(estimateImageTokens(mb1, 'openai')).toBe(1000);

    const mb2 = createImageContent('a'.repeat(1024 * 1024 * 2), 'image/png');
    mb2.originalSizeBytes = 2_000_000;
    expect(estimateImageTokens(mb2, 'openai')).toBe(2000);

    const mb3 = createImageContent('a'.repeat(1024 * 1024 * 6), 'image/png');
    mb3.originalSizeBytes = 6_000_000;
    expect(estimateImageTokens(mb3, 'openai')).toBe(6000);
  });

  it('enforces provider-specific MIME-type limits', () => {
    const image = createImageContent('aGVsbG8=', 'image/webp');
    expect(validateImageForProvider(image, 'ollama')).toMatch(/is not supported by provider "ollama"/);
    expect(validateImageForProvider(image, 'openai')).toBeNull();
  });
});
