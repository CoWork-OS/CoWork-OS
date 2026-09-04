/**
 * Best-effort provider label from model identifiers (no DB lookup).
 * Used by Usage Insights aggregations.
 */
export function inferLlmProvider(modelKey?: string, modelId?: string): string {
  const s = `${modelKey ?? ""} ${modelId ?? ""}`.toLowerCase();
  // Local / Ollama models first (before cloud providers with same base names)
  if (/ollama|\bmlx\b|mlx-community|mlx_lm|:latest\b|local|offline/.test(s)) return "Local";
  if (/anthropic|claude|\bsonnet-\d|\bopus-\d|\bhaiku-\d/.test(s)) return "Anthropic";
  if (/\bopenai\b|gpt-|o1-|o3|o4-|chatgpt|text-davinci/.test(s)) return "OpenAI";
  if (/google|gemini|palm/.test(s)) return "Google";
  if (/\bgrok|xai\b/.test(s)) return "xAI";
  if (/deepseek/.test(s)) return "DeepSeek";
  if (/\bmistral|codestral/.test(s)) return "Mistral";
  if (/\bllama|meta\b/.test(s)) return "Meta";
  if (/kimi|moonshot/.test(s)) return "Moonshot";
  if (/cohere|command-r|command-a/.test(s)) return "Cohere";
  if (/minimax/.test(s)) return "MiniMax";
  if (/:free\b/.test(s)) return "Free";
  return "Other";
}
