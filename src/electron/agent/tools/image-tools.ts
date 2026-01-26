import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { ImageGenerator, ImageModel, ImageSize, ImageGenerationResult } from '../skills/image-generator';
import { LLMTool } from '../llm/types';

/**
 * ImageTools - Tools for AI image generation using Nano Banana models
 *
 * Provides two image generation models:
 * - Nano Banana: Fast generation using Gemini 2.5 Flash Image
 * - Nano Banana Pro: High-quality generation using Gemini 3 Pro
 */
export class ImageTools {
  private imageGenerator: ImageGenerator;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.imageGenerator = new ImageGenerator(workspace);
  }

  /**
   * Generate an image from a text prompt
   */
  async generateImage(input: {
    prompt: string;
    model?: ImageModel;
    filename?: string;
    imageSize?: ImageSize;
    numberOfImages?: number;
  }): Promise<ImageGenerationResult> {
    if (!this.workspace.permissions.write) {
      throw new Error('Write permission not granted for image generation');
    }

    const result = await this.imageGenerator.generate({
      prompt: input.prompt,
      model: input.model || 'nano-banana-pro',
      filename: input.filename,
      imageSize: input.imageSize || '1K',
      numberOfImages: input.numberOfImages || 1,
    });

    // Log events for generated images
    if (result.success) {
      for (const image of result.images) {
        this.daemon.logEvent(this.taskId, 'file_created', {
          path: image.filename,
          type: 'image',
          mimeType: image.mimeType,
          size: image.size,
          model: result.model,
        });
      }
    } else {
      this.daemon.logEvent(this.taskId, 'error', {
        action: 'generate_image',
        error: result.error,
      });
    }

    return result;
  }

  /**
   * Check if image generation is available
   */
  static isAvailable(): boolean {
    return ImageGenerator.isAvailable();
  }

  /**
   * Get tool definitions for image generation
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'generate_image',
        description: `Generate an image from a text description using AI. Two models are available:
- nano-banana: Fast generation using Gemini 2.5 Flash
- nano-banana-pro: High-quality generation using Gemini 3 Pro (default)

The generated images are saved to the workspace folder.`,
        input_schema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Detailed text description of the image to generate. Be specific about subject, style, colors, composition, lighting, etc.',
            },
            model: {
              type: 'string',
              enum: ['nano-banana', 'nano-banana-pro'],
              description: 'The model to use. "nano-banana" for fast generation, "nano-banana-pro" for high quality (default: nano-banana-pro)',
            },
            filename: {
              type: 'string',
              description: 'Output filename without extension (optional, defaults to generated_<timestamp>)',
            },
            imageSize: {
              type: 'string',
              enum: ['1K', '2K'],
              description: 'Size of the generated image. "1K" for 1024px, "2K" for 2048px (default: 1K)',
            },
            numberOfImages: {
              type: 'number',
              description: 'Number of images to generate (1-4, default: 1)',
            },
          },
          required: ['prompt'],
        },
      },
    ];
  }
}
