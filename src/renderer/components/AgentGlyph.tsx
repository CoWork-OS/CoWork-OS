/**
 * AgentGlyph
 *
 * A small multi-color mark that stands for one sub-agent wherever it appears:
 * transcript lifecycle rows, the composer agent lines and the agent sidebar.
 * The shape and palette come from `agent-glyphs.ts`; this file only draws them.
 */

import { useId } from "react";
import type { AgentGlyphShape, AgentGlyphSpec } from "../utils/agent-glyphs";

interface AgentGlyphProps {
  glyph: AgentGlyphSpec;
  size?: number;
  /** Slowly turns the glyph while the agent is still running. */
  working?: boolean;
  className?: string;
  title?: string;
}

const RAY_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const QUARTER_ANGLES = [0, 90, 180, 270];
const BLOOM_ANGLES = [0, 60, 120, 180, 240, 300];

function GlyphShape({
  shape,
  fill,
  accent,
}: {
  shape: AgentGlyphShape;
  fill: string;
  accent: string;
}) {
  switch (shape) {
    case "orb":
      return (
        <>
          <circle cx="12" cy="12" r="10" fill={fill} />
          <ellipse cx="12" cy="12" rx="4.4" ry="10" fill="none" stroke={accent} strokeWidth="1" />
          <path d="M2.6 9h18.8M2.6 15h18.8" fill="none" stroke={accent} strokeWidth="1" />
        </>
      );
    case "diamonds":
      return (
        <>
          {QUARTER_ANGLES.map((angle) => (
            <path
              key={angle}
              d="M12 1.5 15.6 5.1 12 8.7 8.4 5.1Z"
              fill={fill}
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
          <path d="M12 9.4 14.6 12 12 14.6 9.4 12Z" fill={accent} />
        </>
      );
    case "clover":
      return (
        <>
          {[
            [7.6, 7.6],
            [16.4, 7.6],
            [7.6, 16.4],
            [16.4, 16.4],
          ].map(([cx, cy]) => (
            <g key={`${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="4.7" fill={fill} />
              <circle cx={cx} cy={cy} r="1.7" fill={accent} />
            </g>
          ))}
        </>
      );
    case "flower":
      return (
        <>
          {QUARTER_ANGLES.map((angle) => (
            <ellipse
              key={angle}
              cx="12"
              cy="6.6"
              rx="4.3"
              ry="5.2"
              fill={fill}
              transform={`rotate(${angle + 45} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="3.1" fill={accent} />
        </>
      );
    case "starburst":
      return (
        <>
          {RAY_ANGLES.map((angle) => (
            <rect
              key={angle}
              x="10.9"
              y="1.2"
              width="2.2"
              height="8"
              rx="1.1"
              fill={fill}
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="3.4" fill={accent} />
        </>
      );
    case "pinwheel":
      return (
        <>
          {QUARTER_ANGLES.map((angle) => (
            <path
              key={angle}
              d="M12 12C12 6.2 14.8 2.4 20.2 2.4 20.2 7.6 17 12 12 12Z"
              fill={fill}
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="1.9" fill={accent} />
        </>
      );
    case "sparkle":
      return (
        <>
          <path
            d="M12 1.2C12.9 7.6 16.4 11.1 22.8 12 16.4 12.9 12.9 16.4 12 22.8 11.1 16.4 7.6 12.9 1.2 12 7.6 11.1 11.1 7.6 12 1.2Z"
            fill={fill}
          />
          <circle cx="12" cy="12" r="2" fill={accent} />
        </>
      );
    case "bloom":
    default:
      return (
        <>
          {BLOOM_ANGLES.map((angle) => (
            <circle
              key={angle}
              cx="12"
              cy="5.4"
              r="3.7"
              fill={fill}
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="2.8" fill={accent} />
        </>
      );
  }
}

export function AgentGlyph({
  glyph,
  size = 16,
  working = false,
  className,
  title,
}: AgentGlyphProps) {
  const gradientId = `agent-glyph-${useId().replace(/:/g, "")}`;
  const { palette, shape } = glyph;
  return (
    <span
      className={`agent-glyph agent-glyph-${shape}${working ? " is-working" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" focusable="false">
        <defs>
          <radialGradient id={gradientId} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor={palette.light} />
            <stop offset="55%" stopColor={palette.mid} />
            <stop offset="100%" stopColor={palette.deep} />
          </radialGradient>
        </defs>
        <GlyphShape shape={shape} fill={`url(#${gradientId})`} accent={palette.light} />
      </svg>
    </span>
  );
}
