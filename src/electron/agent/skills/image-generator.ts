import * as fs from 'fs';
import * as path from 'path';
import * as mimetypes from 'mime-types';
import { Workspace } from '../../../shared/types';
import { LLMProviderFactory } from '../llm/provider-factory';

/**
 * Image generation model types
 * - nano-banana: Standard image generation using Gemini 2.0 Flash
 * - nano-banana-pro: High-quality image generation using Gemini 3 Pro Image Preview
 */
export type ImageModel = 'nano-banana' | 'nano-banana-pro';

/**
 * Image size options
 */
export type ImageSize = '1K' | '2K';

/**
 * Image generation request
 */
export interface ImageGenerationRequest {
  prompt: string;
  model?: ImageModel;
  filename?: string;
  imageSize?: ImageSize;
  numberOfImages?: number;
}

/**
 * Image generation result
 */
export interface ImageGenerationResult {
  success: boolean;
  images: Array<{
    path: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
  model: string;
  textResponse?: string;
  error?: string;
}

/**
 * Map our model names to Gemini model IDs
 * - nano-banana: gemini-2.5-flash-image (fast, good quality)
 * - nano-banana-pro: gemini-3-pro-image-preview (best quality)
 */
const MODEL_MAP: Record<ImageModel, string> = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-pro': 'gemini-3-pro-image-preview',
};

/**
 * ImageGenerator - Generates images using Google's Gemini models
 *
 * Supports two models:
 * - Nano Banana: Fast generation using Gemini 2.5 Flash Image
 * - Nano Banana Pro: High-quality generation using Gemini 3 Pro Image Preview
 */
export class ImageGenerator {
  constructor(private workspace: Workspace) {}

  /**
   * Generate images from a text prompt using Gemini's generateContent API
   */
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const {
      prompt,
      model = 'nano-banana-pro',
      filename,
      imageSize = '1K',
      numberOfImages = 1,
    } = request;

    // Get Gemini API key from settings
    const settings = LLMProviderFactory.loadSettings();
    const apiKey = settings.gemini?.apiKey;

    if (!apiKey) {
      return {
        success: false,
        images: [],
        model: MODEL_MAP[model],
        error: 'Gemini API key not configured. Please configure it in Settings to use image generation.',
      };
    }

    const modelId = MODEL_MAP[model];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

    try {
      console.log(`[ImageGenerator] Generating image with ${model} (${modelId})`);
      console.log(`[ImageGenerator] Prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

      const images: ImageGenerationResult['images'] = [];
      const baseFilename = filename || `generated_${Date.now()}`;
      const outputDir = this.workspace.path;
      let textResponse: string | undefined;

      // Generate requested number of images (one API call per image for streaming support)
      for (let imageIndex = 0; imageIndex < Math.min(numberOfImages, 4); imageIndex++) {
        const response = await fetch(`${endpoint}?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: prompt,
                  },
                ],
              },
            ],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
              imageConfig: {
                imageSize: imageSize,
              },
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          console.error(`[ImageGenerator] API error: ${response.status} ${response.statusText}`);
          console.error(`[ImageGenerator] Error body:`, errorBody);

          // Parse error for better message
          let errorMessage = `Image generation failed: ${response.status}`;
          try {
            const errorJson = JSON.parse(errorBody);
            if (errorJson.error?.message) {
              errorMessage = errorJson.error.message;
            }
          } catch {
            // Use default message
          }

          // If first image fails, return error
          if (imageIndex === 0) {
            return {
              success: false,
              images: [],
              model: modelId,
              error: errorMessage,
            };
          }
          // Otherwise continue with what we have
          break;
        }

        const data = await response.json() as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                inlineData?: {
                  mimeType: string;
                  data: string;
                };
              }>;
            };
          }>;
        };

        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        for (const part of parts) {
          // Handle text response
          if (part.text) {
            textResponse = part.text;
            console.log(`[ImageGenerator] Text response: ${part.text.substring(0, 100)}...`);
          }

          // Handle image data
          if (part.inlineData?.data) {
            const inlineData = part.inlineData;
            const mimeType = inlineData.mimeType || 'image/png';
            const extension = mimetypes.extension(mimeType) || 'png';

            // Determine filename
            const imageName = numberOfImages > 1
              ? `${baseFilename}_${imageIndex + 1}.${extension}`
              : `${baseFilename}.${extension}`;
            const outputPath = path.join(outputDir, imageName);

            // Decode and save image
            const imageBuffer = Buffer.from(inlineData.data, 'base64');
            await fs.promises.writeFile(outputPath, imageBuffer);

            const stats = await fs.promises.stat(outputPath);

            images.push({
              path: outputPath,
              filename: imageName,
              mimeType: mimeType,
              size: stats.size,
            });

            console.log(`[ImageGenerator] Saved image: ${imageName} (${stats.size} bytes)`);
          }
        }
      }

      if (images.length === 0) {
        return {
          success: false,
          images: [],
          model: modelId,
          textResponse,
          error: textResponse || 'No images were generated. The prompt may have been blocked by safety filters.',
        };
      }

      return {
        success: true,
        images,
        model: modelId,
        textResponse,
      };
    } catch (error: any) {
      console.error(`[ImageGenerator] Error:`, error);
      return {
        success: false,
        images: [],
        model: modelId,
        error: error.message || 'Failed to generate image',
      };
    }
  }

  /**
   * Check if image generation is available (API key configured)
   */
  static isAvailable(): boolean {
    const settings = LLMProviderFactory.loadSettings();
    return !!settings.gemini?.apiKey;
  }

  /**
   * Get available image generation models
   */
  static getAvailableModels(): Array<{
    id: ImageModel;
    name: string;
    description: string;
    modelId: string;
  }> {
    return [
      {
        id: 'nano-banana',
        name: 'Nano Banana',
        description: 'Fast image generation using Gemini 2.5 Flash',
        modelId: MODEL_MAP['nano-banana'],
      },
      {
        id: 'nano-banana-pro',
        name: 'Nano Banana Pro',
        description: 'High-quality image generation using Gemini 3 Pro',
        modelId: MODEL_MAP['nano-banana-pro'],
      },
    ];
  }
}
