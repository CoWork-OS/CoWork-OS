import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOT_MASCOT_IDS } from "../../../../shared/bot-mascots";
import { MASCOT_CATALOG } from "../mascot-catalog";
import {
  MASCOT_CANVAS,
  MASCOT_EXPRESSIONS,
  eyePath,
  eyeShapeFor,
  shapeBlinks,
  type EyeShape,
  type MascotFace,
} from "../mascot-eyes";

const ALL_SHAPES: EyeShape[] = [
  "pill",
  "wide",
  "happy",
  "content",
  "closed",
  "dash",
  "lens",
  "squint",
];

const publicDir = fileURLToPath(new URL("../../../public/", import.meta.url));

function pathNumbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

describe("mascot catalog", () => {
  it("defines every mascot with its eyeless body artwork on disk", () => {
    for (const id of BOT_MASCOT_IDS) {
      const definition = MASCOT_CATALOG[id];
      expect(definition.id).toBe(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.src).toBe(`./bot-mascots/${id}.webp`);
      expect(existsSync(publicDir + definition.src.slice(2))).toBe(true);
    }
  });

  it("places a pair of eyes per face, left to right, inside the artwork", () => {
    for (const id of BOT_MASCOT_IDS) {
      for (const face of MASCOT_CATALOG[id].faces) {
        expect(face.eyes).toHaveLength(2);
        const [left, right] = face.eyes;
        expect(left.x).toBeLessThan(right.x);
        for (const eye of face.eyes) {
          expect(eye.x).toBeGreaterThan(0);
          expect(eye.x).toBeLessThan(MASCOT_CANVAS);
          expect(eye.y).toBeGreaterThan(0);
          expect(eye.y).toBeLessThan(MASCOT_CANVAS);
        }
      }
    }
  });
});

describe("eye shapes", () => {
  it("draws every shape for every face with finite, centred geometry", () => {
    for (const id of BOT_MASCOT_IDS) {
      for (const face of MASCOT_CATALOG[id].faces) {
        for (const shape of ALL_SHAPES) {
          for (const side of [-1, 1] as const) {
            const path = eyePath(shape, face.metrics, 1, side);
            const numbers = pathNumbers(path.d);
            expect(numbers.length).toBeGreaterThan(0);
            expect(numbers.every(Number.isFinite)).toBe(true);
            // Shapes are drawn around the eye centre, so nothing strays far from it.
            expect(Math.max(...numbers.map(Math.abs))).toBeLessThan(60);
            if (path.paint === "stroke") expect(path.strokeWidth).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("points squinting eyes at each other", () => {
    const metrics = MASCOT_CATALOG.code.faces[0].metrics;
    const left = eyePath("squint", metrics, 1, -1).d;
    const right = eyePath("squint", metrics, 1, 1).d;
    // ">" ends at the tip on the right, "<" on the left.
    expect(pathNumbers(left)[2]).toBeGreaterThan(0);
    expect(pathNumbers(right)[2]).toBeLessThan(0);
  });

  it("scales eyes that sit further from the viewer", () => {
    const metrics = MASCOT_CATALOG.code.faces[0].metrics;
    const near = pathNumbers(eyePath("pill", metrics, 1).d);
    const far = pathNumbers(eyePath("pill", metrics, 0.5).d);
    expect(Math.max(...far.map(Math.abs))).toBeCloseTo(Math.max(...near.map(Math.abs)) / 2, 1);
  });

  it("keeps each mascot's drawn look while idle and opens the eyes to work", () => {
    const face = (id: keyof typeof MASCOT_CATALOG): MascotFace => MASCOT_CATALOG[id].faces[0];
    expect(eyeShapeFor(face("write"), "idle")).toBe("happy");
    expect(eyeShapeFor(face("research"), "idle")).toBe("content");
    expect(eyeShapeFor(face("write"), "working")).toBe("pill");
    expect(eyeShapeFor(face("automate"), "working")).toBe("dash");
    expect(eyeShapeFor(face("focus"), "thinking")).toBe("lens");
    expect(eyeShapeFor(face("code"), "sleeping")).toBe("closed");
    expect(eyeShapeFor(face("code"), "attention")).toBe("wide");
    expect(eyeShapeFor(face("code"), "error")).toBe("squint");
    for (const expression of MASCOT_EXPRESSIONS) {
      expect(ALL_SHAPES).toContain(eyeShapeFor(face("code"), expression));
    }
  });

  it("only blinks eyes that are open", () => {
    expect(shapeBlinks("pill")).toBe(true);
    expect(shapeBlinks("dash")).toBe(true);
    expect(shapeBlinks("happy")).toBe(false);
    expect(shapeBlinks("closed")).toBe(false);
  });
});
