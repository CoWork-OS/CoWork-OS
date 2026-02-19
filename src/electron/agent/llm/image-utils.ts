/**
 * Image utilities for LLM provider image input support.
 * Handles validation, token estimation, and fallback for unsupported providers.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  LLMImageContent,
  LLMImageMimeType,
  LLMMessage,
  LLMProviderImageCaps,
  PROVIDER_IMAGE_CAPS,
} from './types';
import type { LLMProviderType } from '../../../shared/types';

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Guess the image MIME type from a file path extension.
 * Returns null for unsupported formats.
 */
export function guessImageMimeType(filePath: string): LLMImageMimeType | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, LLMImageMimeType> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] ?? null;
}

/** Check if a file path has a supported image extension. */
export function isSupportedImageFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Get the image capability limits for a given provider type. */
export function getProviderImageCaps(providerType: LLMProviderType): LLMProviderImageCaps {
  return PROVIDER_IMAGE_CAPS[providerType] ?? { supportsImages: false, maxImageBytes: 0, supportedMimeTypes: [] };
}

/**
 * Validate an image against a provider's limits.
 * Returns null if valid, or an error string describing the issue.
 */
export function validateImageForProvider(
  image: LLMImageContent,
  providerType: LLMProviderType,
): string | null {
  const caps = getProviderImageCaps(providerType);
  if (!caps.supportsImages) {
    return `Provider "${providerType}" does not support inline images.`;
  }
  const rawSize = image.originalSizeBytes ?? Math.ceil(image.data.length * 3 / 4);
  if (rawSize > caps.maxImageBytes) {
    const sizeMB = (rawSize / (1024 * 1024)).toFixed(1);
    const limitMB = (caps.maxImageBytes / (1024 * 1024)).toFixed(0);
    return `Image is ${sizeMB}MB but provider "${providerType}" supports max ${limitMB}MB.`;
  }
  if (!caps.supportedMimeTypes.includes(image.mimeType)) {
    return `Image type "${image.mimeType}" is not supported by provider "${providerType}".`;
  }
  return null;
}

/**
 * Read an image file from disk and produce an LLMImageContent.
 */
export async function loadImageFromFile(filePath: string): Promise<LLMImageContent> {
  const mimeType = guessImageMimeType(filePath);
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${path.extname(filePath)}`);
  }
  const buffer = await fs.readFile(filePath);
  return {
    type: 'image',
    data: buffer.toString('base64'),
    mimeType,
    originalSizeBytes: buffer.length,
  };
}

/**
 * Create an LLMImageContent from a base64 string and MIME type (for UI uploads).
 */
export function createImageContent(base64Data: string, mimeType: LLMImageMimeType): LLMImageContent {
  const rawSize = Math.ceil(base64Data.length * 3 / 4);
  return {
    type: 'image',
    data: base64Data,
    mimeType,
    originalSizeBytes: rawSize,
  };
}

/**
 * Estimate the token cost of an image for context window accounting.
 *
 * - Gemini: fixed 258 tokens per image
 * - Anthropic/Bedrock: ~1600 tokens per megapixel (approximated from file size)
 * - OpenAI: varies by detail mode; approximated from file size
 *
 * Without actual image dimensions we use file-size heuristics.
 */
export function estimateImageTokens(image: LLMImageContent, providerType?: string): number {
  if (providerType === 'gemini') {
    return 258;
  }
  const sizeBytes = image.originalSizeBytes ?? Math.ceil(image.data.length * 3 / 4);
  const sizeMB = sizeBytes / (1024 * 1024);
  if (sizeMB <= 0.5) return 1000;
  if (sizeMB <= 2) return 2000;
  if (sizeMB <= 5) return 4000;
  return 6000;
}

/**
 * Produce a text description as a fallback for providers that do not support images.
 */
export function imageToTextFallback(image: LLMImageContent): string {
  const sizeBytes = image.originalSizeBytes ?? Math.ceil(image.data.length * 3 / 4);
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `[Image attached: ${image.mimeType}, ${sizeMB}MB — this provider does not support inline images. Use the "analyze_image" tool to process this image, or switch to a vision-capable provider.]`;
}

/**
 * Replace image content blocks with text fallback for providers
 * that do not support inline images.
 * Returns messages unchanged if the provider supports images.
 */
export function stripImagesForUnsupportedProvider(
  messages: LLMMessage[],
  providerType: LLMProviderType,
): LLMMessage[] {
  const caps = getProviderImageCaps(providerType);
  if (caps.supportsImages) return messages;

  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    const newContent = (msg.content as any[]).map((item: any) => {
      if (item.type === 'image') {
        return { type: 'text' as const, text: imageToTextFallback(item) };
      }
      return item;
    });
    return { ...msg, content: newContent } as LLMMessage;
  });
}
