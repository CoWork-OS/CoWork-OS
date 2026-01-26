/**
 * Model Pricing Table
 *
 * Contains pricing information for various LLM models.
 * Prices are per 1 million tokens in USD.
 */

export interface ModelPricing {
  inputPer1M: number;  // Cost per 1M input tokens in USD
  outputPer1M: number; // Cost per 1M output tokens in USD
}

/**
 * Model pricing table (per 1M tokens in USD)
 * Updated as of January 2025
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude models
  'claude-opus-4-5-20250101': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-5-20250514': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-3-5-sonnet-latest': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.80, outputPer1M: 4.00 },
  'claude-3-5-haiku-latest': { inputPer1M: 0.80, outputPer1M: 4.00 },
  'claude-3-opus-20240229': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-3-sonnet-20240229': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-3-haiku-20240307': { inputPer1M: 0.25, outputPer1M: 1.25 },

  // AWS Bedrock model IDs
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.80, outputPer1M: 4.00 },
  'anthropic.claude-3-opus-20240229-v1:0': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'anthropic.claude-3-sonnet-20240229-v1:0': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'us.anthropic.claude-opus-4-5-20251101-v1:0': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'us.anthropic.claude-sonnet-4-5-20250514-v1:0': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1M: 3.00, outputPer1M: 15.00 },

  // Google Gemini models (prices may vary, free tier has limits)
  'gemini-2.0-flash': { inputPer1M: 0.10, outputPer1M: 0.40 },
  'gemini-2.0-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5.00 },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.00 },
  'gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.30 },

  // OpenRouter passes through various model pricing
  // These are common models accessed through OpenRouter
  'anthropic/claude-3.5-sonnet': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'anthropic/claude-3-opus': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'openai/gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'google/gemini-pro-1.5': { inputPer1M: 1.25, outputPer1M: 5.00 },
  'meta-llama/llama-3.1-405b-instruct': { inputPer1M: 3.00, outputPer1M: 3.00 },
  'meta-llama/llama-3.1-70b-instruct': { inputPer1M: 0.52, outputPer1M: 0.75 },

  // Ollama (local) - free
  // Ollama models are free since they run locally

  // Google Gemini image generation models
  // Note: Image generation is priced per image, not per token
  // These are approximate costs (actual pricing may vary)
  'gemini-2.5-flash-image': { inputPer1M: 0.00, outputPer1M: 0.00 },      // Nano Banana
  'gemini-3-pro-image-preview': { inputPer1M: 0.00, outputPer1M: 0.00 },  // Nano Banana Pro
};

/**
 * Image generation pricing (per image in USD)
 * Separate from token-based pricing for LLMs
 */
export const IMAGE_GENERATION_PRICING: Record<string, number> = {
  'gemini-2.5-flash-image': 0.02,         // Nano Banana - ~$0.02 per image
  'gemini-3-pro-image-preview': 0.04,     // Nano Banana Pro - ~$0.04 per image
  'nano-banana': 0.02,                    // Alias
  'nano-banana-pro': 0.04,                // Alias
};

/**
 * Calculate the cost of an LLM API call
 * @param modelId The model identifier
 * @param inputTokens Number of input tokens
 * @param outputTokens Number of output tokens
 * @returns Cost in USD
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Try exact match first
  let pricing = MODEL_PRICING[modelId];

  // If no exact match, try to find a partial match
  if (!pricing) {
    const modelIdLower = modelId.toLowerCase();
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      if (modelIdLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelIdLower)) {
        pricing = value;
        break;
      }
    }
  }

  // If still no match, return 0 (unknown model or local model)
  if (!pricing) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return inputCost + outputCost;
}

/**
 * Get pricing info for a model (for display)
 * @param modelId The model identifier
 * @returns Pricing info or null if unknown
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  // Try exact match first
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try partial match
  const modelIdLower = modelId.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_PRICING)) {
    if (modelIdLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelIdLower)) {
      return value;
    }
  }

  return null;
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate the cost of image generation
 * @param modelId The image model identifier (e.g., 'nano-banana', 'imagen-3.0-fast-generate-001')
 * @param numberOfImages Number of images generated
 * @returns Cost in USD
 */
export function calculateImageCost(modelId: string, numberOfImages: number): number {
  const pricePerImage = IMAGE_GENERATION_PRICING[modelId] || IMAGE_GENERATION_PRICING[modelId.toLowerCase()];
  if (!pricePerImage) {
    // Default to Nano Banana pricing if unknown model
    return 0.03 * numberOfImages;
  }
  return pricePerImage * numberOfImages;
}

/**
 * Get image generation pricing info for a model
 * @param modelId The image model identifier
 * @returns Price per image in USD, or null if unknown
 */
export function getImagePricing(modelId: string): number | null {
  return IMAGE_GENERATION_PRICING[modelId] || IMAGE_GENERATION_PRICING[modelId.toLowerCase()] || null;
}
