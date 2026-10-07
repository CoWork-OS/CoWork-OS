import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import type { BotMascotId } from "../../../shared/bot-mascots";
import { BotMascot } from "./BotMascot";

const glyphs = new Map<BotMascotId, ComponentType<LucideProps>>();

/**
 * A mascot shaped like a lucide icon component, so call sites that render
 * whatever `resolveTwinIcon` returns (`<Icon size={16} />`) show the mascot too.
 * Cached per mascot so the component identity is stable across renders.
 */
export function getMascotGlyph(mascot: BotMascotId): ComponentType<LucideProps> {
  const cached = glyphs.get(mascot);
  if (cached) return cached;
  function MascotGlyph({ size = 24, className, "aria-label": ariaLabel }: LucideProps) {
    const px = typeof size === "number" ? size : Number.parseFloat(size) || 24;
    return <BotMascot mascot={mascot} size={px} className={className} aria-label={ariaLabel} />;
  }
  glyphs.set(mascot, MascotGlyph);
  return MascotGlyph;
}
