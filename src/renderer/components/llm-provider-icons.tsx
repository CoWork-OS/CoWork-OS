import type { ReactNode } from "react";
import {
  AtSign,
  Box,
  CircleDot,
  Cloud,
  Crosshair,
  Globe,
  Hexagon,
  Layers,
  Pi,
  Plus,
  Sparkles,
  Star,
  UsersRound,
  Zap,
} from "lucide-react";

const S = { size: 16, strokeWidth: 1.5 } as const;

export const LLM_PROVIDER_ICONS: Record<string, ReactNode> = {
  anthropic: <Layers {...S} />,
  openai: <CircleDot {...S} />,
  azure: <Cloud {...S} />,
  "azure-anthropic": <Cloud {...S} />,
  gemini: <Star {...S} />,
  openrouter: <Globe {...S} />,
  deepseek: <Hexagon {...S} />,
  ollama: <Box {...S} />,
  groq: <Crosshair {...S} />,
  xai: <AtSign {...S} />,
  "xai-oauth": <AtSign {...S} />,
  kimi: <Sparkles {...S} />,
  "nano-gpt": <Sparkles {...S} />,
  bedrock: <Hexagon {...S} />,
  pi: <Pi {...S} />,
  moa: <UsersRound {...S} />,
  "hf-agents": <Zap {...S} />,
  mlx: <Sparkles {...S} />,
};

/**
 * Icon for an LLM provider. Custom providers fall back to the icon of the
 * wire protocol they speak, then to a generic placeholder.
 */
export function getLLMProviderIcon(
  providerType: string,
  customEntry?: { compatibility?: string },
): ReactNode {
  if (LLM_PROVIDER_ICONS[providerType]) {
    return LLM_PROVIDER_ICONS[providerType];
  }
  if (customEntry?.compatibility === "anthropic") {
    return LLM_PROVIDER_ICONS.anthropic;
  }
  if (customEntry?.compatibility === "openai") {
    return LLM_PROVIDER_ICONS.openai;
  }
  return <Plus {...S} />;
}
