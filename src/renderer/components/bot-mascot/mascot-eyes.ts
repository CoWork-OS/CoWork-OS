/**
 * Eye geometry for the illustrated bot mascots.
 *
 * The mascot artwork ships with its painted eyes removed, so the eyes are drawn
 * here as SVG on top of the body image. Every shape is centred on (0, 0) in the
 * eye's own frame; the caller positions and rotates that frame onto the face.
 * Coordinates are in the 256×256 space the artwork is exported at.
 */

export const MASCOT_CANVAS = 256;

/** What the eyes are doing. The face picks a shape and motion for each one. */
export type MascotExpression =
  | "idle"
  | "thinking"
  | "working"
  | "happy"
  | "sleeping"
  | "attention"
  | "error";

export const MASCOT_EXPRESSIONS: readonly MascotExpression[] = [
  "idle",
  "thinking",
  "working",
  "happy",
  "sleeping",
  "attention",
  "error",
];

export type EyeShape =
  | "pill"
  | "wide"
  | "happy"
  | "content"
  | "closed"
  | "dash"
  | "lens"
  | "squint";

/** Glowing eyes on a dark face plate, or dark eyes painted on the body. */
export type EyeTone = { kind: "glow"; core: string; glow: string } | { kind: "ink"; core: string };

export interface EyeMetrics {
  /** An open eye: stroke-free capsule `w` wide and `h` tall. */
  pill: { w: number; h: number };
  /** Curved eyes (happy, content, closed, squint): chord width, height, line thickness. */
  arc: { w: number; h: number; t: number };
  /** Flat capsule eyes, drawn horizontally. */
  dash?: { w: number; t: number };
  /** Half-lidded eyes: flat lid on top, rounded underneath. */
  lens?: { w: number; h: number };
}

export interface EyePlacement {
  x: number;
  y: number;
  /** Degrees, clockwise. Follows the tilt of the face in the artwork. */
  rot: number;
  /** Size relative to the face metrics; eyes further from the viewer are smaller. */
  scale?: number;
}

/** How far the eyes may travel from rest while staying on the face. */
export interface LookRange {
  left: number;
  right: number;
  up: number;
  down: number;
}

export interface MascotFace {
  tone: EyeTone;
  /** Shape the artwork was drawn with; used while idle. */
  rest: EyeShape;
  /** Shape used when the eyes need to be open (thinking, working). Defaults to `pill`. */
  open?: EyeShape;
  metrics: EyeMetrics;
  /** Ordered left to right on screen. */
  eyes: EyePlacement[];
  look: LookRange;
}

export interface EyePath {
  d: string;
  /** Filled outline, or a centre line drawn with round caps at `strokeWidth`. */
  paint: "fill" | "stroke";
  strokeWidth?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function capsule(width: number, height: number): string {
  const w = round(width);
  const h = round(height);
  const r = round(Math.min(w, h) / 2);
  if (h >= w) {
    const top = round(-h / 2 + r);
    const bottom = round(h / 2 - r);
    return `M ${-r} ${top} A ${r} ${r} 0 0 1 ${r} ${top} L ${r} ${bottom} A ${r} ${r} 0 0 1 ${-r} ${bottom} Z`;
  }
  const left = round(-w / 2 + r);
  const right = round(w / 2 - r);
  return `M ${left} ${-r} L ${right} ${-r} A ${r} ${r} 0 0 1 ${right} ${r} L ${left} ${r} A ${r} ${r} 0 0 1 ${left} ${-r} Z`;
}

/** A centre line that bows up (`dir = -1`) or down (`dir = 1`), sized so the stroked result fits `w × h`. */
function bow(w: number, h: number, t: number, dir: 1 | -1): string {
  const a = round(Math.max(w - t, 0) / 2);
  const d = round(Math.max(h - t, 0) / 2);
  const reach = round(dir * d * 1.62);
  const end = round(-dir * d);
  const ctrl = round(a * 0.62);
  return `M ${-a} ${end} C ${-ctrl} ${reach} ${ctrl} ${reach} ${a} ${end}`;
}

/**
 * Build the path for one eye.
 * `side` is -1 for the left eye and 1 for the right; only asymmetric shapes use it.
 */
export function eyePath(
  shape: EyeShape,
  metrics: EyeMetrics,
  scale = 1,
  side: -1 | 1 = -1,
): EyePath {
  const s = scale;
  const { pill, arc } = metrics;
  switch (shape) {
    case "pill":
      return { d: capsule(pill.w * s, pill.h * s), paint: "fill" };
    case "wide":
      return { d: capsule(pill.w * 1.35 * s, pill.h * 1.1 * s), paint: "fill" };
    case "happy":
      return {
        d: bow(arc.w * s, arc.h * s, arc.t * s, -1),
        paint: "stroke",
        strokeWidth: round(arc.t * s),
      };
    case "content":
      return {
        d: bow(arc.w * s, arc.h * s, arc.t * s, 1),
        paint: "stroke",
        strokeWidth: round(arc.t * s),
      };
    case "closed": {
      const t = arc.t * 0.85 * s;
      return {
        d: bow(arc.w * 0.92 * s, t + arc.h * 0.22 * s, t, 1),
        paint: "stroke",
        strokeWidth: round(t),
      };
    }
    case "dash": {
      const dash = metrics.dash ?? { w: arc.w, t: arc.t * 1.4 };
      return { d: capsule(dash.w * s, dash.t * s), paint: "fill" };
    }
    case "lens": {
      const lens = metrics.lens ?? { w: arc.w * 1.2, h: pill.h * 0.6 };
      const a = round((lens.w * s) / 2);
      const top = round((-lens.h * s) / 2);
      const lid = round(top - lens.h * 0.12 * s);
      const belly = round(lens.h * 0.75 * s);
      const ctrl = round(a * 0.55);
      return {
        d: `M ${-a} ${top} Q 0 ${lid} ${a} ${top} C ${ctrl} ${belly} ${-ctrl} ${belly} ${-a} ${top} Z`,
        paint: "fill",
      };
    }
    case "squint": {
      // ">" on the left eye and "<" on the right, so both point at the nose.
      const t = arc.t * 0.85 * s;
      const a = round(arc.w * 0.4 * s - t / 2);
      const d = round(arc.h * 0.75 * s - t / 2);
      const tip = round(-side * a);
      return {
        d: `M ${-tip} ${-d} L ${tip} 0 L ${-tip} ${d}`,
        paint: "stroke",
        strokeWidth: round(t),
      };
    }
  }
}

/** The shape a face shows for an expression. */
export function eyeShapeFor(face: MascotFace, expression: MascotExpression): EyeShape {
  switch (expression) {
    case "idle":
      return face.rest;
    case "thinking":
    case "working":
      return face.open ?? "pill";
    case "happy":
      return "happy";
    case "sleeping":
      return "closed";
    case "attention":
      return "wide";
    case "error":
      return "squint";
  }
}

/** Curved and closed shapes have nothing to blink. */
export function shapeBlinks(shape: EyeShape): boolean {
  return shape === "pill" || shape === "wide" || shape === "dash" || shape === "lens";
}
