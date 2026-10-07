import type { BotMascotId } from "../../../shared/bot-mascots";
import type { MascotFace } from "./mascot-eyes";

export interface MascotDefinition {
  id: BotMascotId;
  label: string;
  /** Body artwork with the eyes painted out, served from `src/renderer/public`. */
  src: string;
  faces: MascotFace[];
}

const asset = (id: BotMascotId): string => `./bot-mascots/${id}.webp`;

/**
 * Eye placement for each mascot, measured from the source artwork. Positions are
 * in the 256×256 export space, so they line up with the body image at any size.
 */
export const MASCOT_CATALOG: Record<BotMascotId, MascotDefinition> = {
  code: {
    id: "code",
    label: "Code",
    src: asset("code"),
    faces: [
      {
        tone: { kind: "glow", core: "#FDF8CB", glow: "#FFD98A" },
        rest: "pill",
        metrics: { pill: { w: 15, h: 41.5 }, arc: { w: 34, h: 17, t: 9.5 } },
        eyes: [
          { x: 134.5, y: 144.5, rot: -3 },
          { x: 199, y: 144.5, rot: -4 },
        ],
        look: { left: 10, right: 10, up: 8, down: 8 },
      },
    ],
  },
  research: {
    id: "research",
    label: "Research",
    src: asset("research"),
    faces: [
      {
        tone: { kind: "glow", core: "#E4F1FE", glow: "#B4C2FF" },
        rest: "content",
        metrics: { pill: { w: 13, h: 29 }, arc: { w: 32.5, h: 17, t: 8 } },
        eyes: [
          { x: 119.5, y: 155, rot: 9 },
          { x: 173.3, y: 159.3, rot: 1, scale: 0.84 },
        ],
        look: { left: 8, right: 3, up: 6, down: 6 },
      },
    ],
  },
  write: {
    id: "write",
    label: "Write",
    src: asset("write"),
    faces: [
      {
        tone: { kind: "glow", core: "#FEF9EC", glow: "#FFE3BF" },
        rest: "happy",
        metrics: { pill: { w: 13, h: 30 }, arc: { w: 31.5, h: 18.5, t: 8 } },
        eyes: [
          { x: 95, y: 138.1, rot: -3, scale: 0.92 },
          { x: 148.7, y: 135.8, rot: -3 },
        ],
        look: { left: 10, right: 10, up: 7, down: 8 },
      },
    ],
  },
  plan: {
    id: "plan",
    label: "Plan",
    src: asset("plan"),
    faces: [
      {
        tone: { kind: "glow", core: "#F4FDEB", glow: "#9CFFC0" },
        rest: "pill",
        metrics: { pill: { w: 13.5, h: 26.5 }, arc: { w: 24, h: 12, t: 8 } },
        eyes: [
          { x: 86.3, y: 151.1, rot: -7, scale: 0.96 },
          { x: 132.5, y: 147.8, rot: -6 },
        ],
        look: { left: 12, right: 12, up: 4, down: 4 },
      },
    ],
  },
  browse: {
    id: "browse",
    label: "Browse",
    src: asset("browse"),
    faces: [
      {
        tone: { kind: "glow", core: "#FDF5D5", glow: "#FFD9A6" },
        rest: "happy",
        metrics: { pill: { w: 14, h: 32 }, arc: { w: 36.5, h: 19, t: 8.4 } },
        eyes: [
          { x: 129.5, y: 141.4, rot: 3 },
          { x: 187.3, y: 144.9, rot: 4, scale: 0.86 },
        ],
        look: { left: 7, right: 7, up: 5, down: 6 },
      },
    ],
  },
  analyze: {
    id: "analyze",
    label: "Analyze",
    src: asset("analyze"),
    faces: [
      {
        tone: { kind: "glow", core: "#DEFAFE", glow: "#86B6FF" },
        rest: "pill",
        metrics: { pill: { w: 15, h: 34.5 }, arc: { w: 30, h: 15, t: 9 } },
        eyes: [
          { x: 116.6, y: 123.4, rot: 15 },
          { x: 173, y: 136.6, rot: 14 },
        ],
        look: { left: 12, right: 12, up: 9, down: 9 },
      },
    ],
  },
  create: {
    id: "create",
    label: "Create",
    src: asset("create"),
    faces: [
      {
        tone: { kind: "glow", core: "#FEF6DE", glow: "#FFC09E" },
        rest: "happy",
        metrics: { pill: { w: 11.5, h: 24 }, arc: { w: 26.5, h: 15.5, t: 6.6 } },
        eyes: [
          { x: 99.4, y: 135.8, rot: -18, scale: 0.9 },
          { x: 140.3, y: 123.5, rot: -16 },
        ],
        look: { left: 6, right: 6, up: 4, down: 5 },
      },
    ],
  },
  automate: {
    id: "automate",
    label: "Automate",
    src: asset("automate"),
    faces: [
      {
        tone: { kind: "ink", core: "#141418" },
        rest: "dash",
        open: "dash",
        metrics: {
          pill: { w: 14, h: 26 },
          arc: { w: 32, h: 15, t: 9 },
          dash: { w: 39.5, t: 14 },
        },
        eyes: [
          { x: 85.2, y: 144.5, rot: -6 },
          { x: 148.4, y: 139.5, rot: -5 },
        ],
        look: { left: 8, right: 8, up: 4, down: 4 },
      },
    ],
  },
  assist: {
    id: "assist",
    label: "Assist",
    src: asset("assist"),
    faces: [
      {
        tone: { kind: "glow", core: "#EEFDFD", glow: "#84B6FF" },
        rest: "pill",
        metrics: { pill: { w: 13, h: 25 }, arc: { w: 22, h: 11, t: 7.5 } },
        eyes: [
          { x: 115.1, y: 151.4, rot: -5 },
          { x: 156, y: 147.3, rot: -9, scale: 0.96 },
        ],
        look: { left: 10, right: 10, up: 8, down: 8 },
      },
    ],
  },
  learn: {
    id: "learn",
    label: "Learn",
    src: asset("learn"),
    faces: [
      {
        tone: { kind: "glow", core: "#EBFBE6", glow: "#C4FFB8" },
        rest: "content",
        metrics: { pill: { w: 14, h: 31 }, arc: { w: 34.5, h: 19, t: 8.4 } },
        eyes: [
          { x: 120.7, y: 159.4, rot: -13 },
          { x: 173.7, y: 147.1, rot: -15, scale: 0.95 },
        ],
        look: { left: 10, right: 10, up: 8, down: 8 },
      },
    ],
  },
  collaborate: {
    id: "collaborate",
    label: "Collaborate",
    src: asset("collaborate"),
    faces: [
      {
        tone: { kind: "glow", core: "#F5EAFB", glow: "#D9CDFF" },
        rest: "pill",
        metrics: { pill: { w: 9, h: 19.5 }, arc: { w: 16, h: 8, t: 5.5 } },
        eyes: [
          { x: 61.4, y: 121.8, rot: 12 },
          { x: 87.6, y: 127.9, rot: 10 },
        ],
        look: { left: 6, right: 4, up: 6, down: 6 },
      },
      {
        tone: { kind: "ink", core: "#0B1E4E" },
        rest: "pill",
        metrics: { pill: { w: 8.2, h: 16 }, arc: { w: 13, h: 7, t: 4.5 } },
        eyes: [
          { x: 217.1, y: 117.8, rot: -16 },
          { x: 232.2, y: 120.6, rot: -12, scale: 0.92 },
        ],
        look: { left: 2, right: 2, up: 2, down: 2 },
      },
    ],
  },
  organize: {
    id: "organize",
    label: "Organize",
    src: asset("organize"),
    faces: [
      {
        tone: { kind: "glow", core: "#FBEFB0", glow: "#FFDD7A" },
        rest: "pill",
        metrics: { pill: { w: 13.5, h: 36 }, arc: { w: 30, h: 15, t: 9 } },
        eyes: [
          { x: 71, y: 142.6, rot: 3 },
          { x: 115.1, y: 148.9, rot: 3 },
        ],
        look: { left: 10, right: 10, up: 8, down: 8 },
      },
    ],
  },
  search: {
    id: "search",
    label: "Search",
    src: asset("search"),
    faces: [
      {
        tone: { kind: "glow", core: "#FAFBFD", glow: "#DCE3FF" },
        rest: "pill",
        metrics: { pill: { w: 11.5, h: 27 }, arc: { w: 23, h: 11.5, t: 7.5 } },
        eyes: [
          { x: 136.1, y: 126.4, rot: -16 },
          { x: 169.2, y: 114.4, rot: -15, scale: 0.96 },
        ],
        look: { left: 10, right: 10, up: 8, down: 6 },
      },
    ],
  },
  focus: {
    id: "focus",
    label: "Focus",
    src: asset("focus"),
    faces: [
      {
        tone: { kind: "ink", core: "#1A1411" },
        rest: "lens",
        open: "lens",
        metrics: {
          pill: { w: 16, h: 26 },
          arc: { w: 40, h: 18, t: 10 },
          lens: { w: 51, h: 20 },
        },
        eyes: [
          { x: 53.1, y: 154.7, rot: -12, scale: 0.8 },
          { x: 118.9, y: 127.8, rot: -17 },
        ],
        look: { left: 5, right: 5, up: 3, down: 3 },
      },
    ],
  },
  reason: {
    id: "reason",
    label: "Reason",
    src: asset("reason"),
    faces: [
      {
        tone: { kind: "glow", core: "#F1FBFC", glow: "#A6CCFF" },
        rest: "pill",
        metrics: { pill: { w: 12.5, h: 27.5 }, arc: { w: 23, h: 11.5, t: 7.5 } },
        eyes: [
          { x: 108.6, y: 148.9, rot: 1 },
          { x: 160.2, y: 146.5, rot: 2 },
        ],
        look: { left: 10, right: 10, up: 7, down: 8 },
      },
    ],
  },
  everything: {
    id: "everything",
    label: "Everything",
    src: asset("everything"),
    faces: [
      {
        tone: { kind: "glow", core: "#EEFAFD", glow: "#B2D5FF" },
        rest: "pill",
        metrics: { pill: { w: 8.5, h: 17.5 }, arc: { w: 15, h: 7.5, t: 5 } },
        eyes: [
          { x: 61.8, y: 122, rot: -1, scale: 0.95 },
          { x: 81.4, y: 120.7, rot: -2 },
        ],
        look: { left: 6, right: 8, up: 6, down: 7 },
      },
    ],
  },
};
