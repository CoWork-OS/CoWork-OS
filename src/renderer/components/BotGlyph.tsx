import { RobotIcon } from "@phosphor-icons/react";

export type BotGlyphWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export interface BotGlyphProps {
  size?: string | number;
  /** `duotone` for avatars and cards, `regular` for inline menu rows. */
  weight?: BotGlyphWeight;
  className?: string;
  /** Pass a label when the glyph is the only thing identifying a control. */
  "aria-label"?: string;
  /**
   * Accepted and ignored so this can stand in for a lucide icon in the twin
   * icon registry, whose call sites pass a stroke width. Phosphor expresses the
   * same idea through `weight`.
   */
  strokeWidth?: string | number;
}

/**
 * The single source for the bot mark. Bot surfaces draw from Phosphor rather
 * than the lucide set the rest of the app uses, so route every bot icon through
 * here — importing the icon directly is how the two marks drifted apart before.
 */
export function BotGlyph({
  size = 16,
  weight = "duotone",
  className,
  "aria-label": ariaLabel,
}: BotGlyphProps) {
  return (
    <RobotIcon
      size={size}
      weight={weight}
      className={className}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    />
  );
}
