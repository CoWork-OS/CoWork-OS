import { useId, useState, type CSSProperties } from "react";
import type { BotMascotId } from "../../../shared/bot-mascots";
import { MASCOT_CATALOG } from "./mascot-catalog";
import {
  MASCOT_CANVAS,
  eyePath,
  eyeShapeFor,
  shapeBlinks,
  type MascotExpression,
  type MascotFace,
} from "./mascot-eyes";
import "./bot-mascot.css";

export interface BotMascotProps {
  mascot: BotMascotId;
  /** Width and height in px. */
  size?: number;
  expression?: MascotExpression;
  /**
   * Idle blinking and glancing, plus the motion for each expression. Turn off for
   * static thumbnails; the eye shapes still follow `expression`.
   */
  animated?: boolean;
  className?: string;
  /** Pass a label when the mascot is the only thing identifying a control. */
  "aria-label"?: string;
}

/** Below this the glow is sub-pixel, so the filter is skipped. */
const GLOW_MIN_SIZE = 40;

/** FNV-1a, so each instance gets its own stable blink and glance rhythm. */
function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic value in [0, 1) for a seed and a salt. */
function seededUnit(seed: number, salt: number): number {
  let x = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function rhythmVars(seed: number): CSSProperties {
  const blink = 3.8 + seededUnit(seed, 1) * 3;
  const glance = 9 + seededUnit(seed, 2) * 6;
  // Negative delays start each instance part-way through its cycle, so a list of
  // bots never blinks in unison.
  return {
    "--bm-blink-dur": `${blink.toFixed(2)}s`,
    "--bm-blink-delay": `${(-seededUnit(seed, 3) * blink).toFixed(2)}s`,
    "--bm-glance-dur": `${glance.toFixed(2)}s`,
    "--bm-glance-delay": `${(-seededUnit(seed, 4) * glance).toFixed(2)}s`,
  } as CSSProperties;
}

function faceVars(face: MascotFace, seed: number, index: number): CSSProperties {
  const vars: Record<string, string | number> = {
    "--bm-look-left": face.look.left,
    "--bm-look-right": face.look.right,
    "--bm-look-up": face.look.up,
    "--bm-look-down": face.look.down,
  };
  // Mascots with a second face blink on their own beat.
  if (index > 0) vars["--bm-blink-delay"] = `${(-seededUnit(seed, 10 + index) * 4).toFixed(2)}s`;
  return vars as CSSProperties;
}

export function BotMascot({
  mascot,
  size = 32,
  expression = "idle",
  animated = true,
  className,
  "aria-label": ariaLabel,
}: BotMascotProps) {
  const definition = MASCOT_CATALOG[mascot];
  const instanceId = useId();
  const seed = hashSeed(instanceId);
  const filterBase = `bot-mascot-glow-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // The eyes "pop" into a new shape when the expression changes, but not on mount.
  const [shownExpression, setShownExpression] = useState(expression);
  const [hasChanged, setHasChanged] = useState(false);
  if (expression !== shownExpression) {
    setShownExpression(expression);
    setHasChanged(true);
  }

  const glow = size >= GLOW_MIN_SIZE;
  const classes = ["bot-mascot", animated ? "bot-mascot--animated" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox={`0 0 ${MASCOT_CANVAS} ${MASCOT_CANVAS}`}
      data-mascot={mascot}
      data-expression={expression}
      style={animated ? rhythmVars(seed) : undefined}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
    >
      {glow && (
        <defs>
          {definition.faces.map((face, index) =>
            face.tone.kind === "glow" ? (
              <filter
                key={index}
                id={`${filterBase}-${index}`}
                filterUnits="userSpaceOnUse"
                x={-32}
                y={-32}
                width={MASCOT_CANVAS + 64}
                height={MASCOT_CANVAS + 64}
                colorInterpolationFilters="sRGB"
              >
                <feGaussianBlur
                  in="SourceAlpha"
                  stdDeviation={(face.metrics.pill.w * 0.3).toFixed(2)}
                  result="blur"
                />
                <feFlood floodColor={face.tone.glow} floodOpacity={0.95} result="tint" />
                <feComposite in="tint" in2="blur" operator="in" result="halo" />
                <feMerge>
                  <feMergeNode in="halo" />
                  <feMergeNode in="halo" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            ) : null,
          )}
        </defs>
      )}
      <image
        className="bot-mascot__body"
        href={definition.src}
        width={MASCOT_CANVAS}
        height={MASCOT_CANVAS}
        preserveAspectRatio="xMidYMid meet"
      />
      {definition.faces.map((face, faceIndex) => {
        const shape = eyeShapeFor(face, expression);
        const lidClass = shapeBlinks(shape)
          ? "bot-mascot__lid bot-mascot__lid--blink"
          : "bot-mascot__lid";
        const eyeClass = hasChanged ? "bot-mascot__eye bot-mascot__eye--pop" : "bot-mascot__eye";
        return (
          <g
            key={faceIndex}
            className="bot-mascot__face"
            style={faceVars(face, seed, faceIndex)}
            filter={
              glow && face.tone.kind === "glow" ? `url(#${filterBase}-${faceIndex})` : undefined
            }
          >
            {face.eyes.map((eye, eyeIndex) => {
              const path = eyePath(shape, face.metrics, eye.scale ?? 1, eyeIndex === 0 ? -1 : 1);
              return (
                <g key={eyeIndex} transform={`translate(${eye.x} ${eye.y}) rotate(${eye.rot})`}>
                  <g className={lidClass}>
                    {path.paint === "fill" ? (
                      <path key={shape} className={eyeClass} d={path.d} fill={face.tone.core} />
                    ) : (
                      <path
                        key={shape}
                        className={eyeClass}
                        d={path.d}
                        fill="none"
                        stroke={face.tone.core}
                        strokeWidth={path.strokeWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </g>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
