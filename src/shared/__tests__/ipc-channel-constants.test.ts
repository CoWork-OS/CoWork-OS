import { describe, expect, it } from "vitest";
import fs from "node:fs";

function extractChannelMap(source: string, marker: string): Record<string, string> {
  const start = source.indexOf(marker);
  if (start < 0) {
    return {};
  }

  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) {
    return {};
  }

  let depth = 0;
  let endBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }

  if (endBrace < 0) {
    return {};
  }

  const objectBody = source.slice(openBrace + 1, endBrace);
  const entries = [...objectBody.matchAll(/\n\s*([A-Z0-9_]+)\s*:\s*"([^"]+)"/g)];

  return Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
}

describe("IPC channel definitions", () => {
  const preloadSource = fs.readFileSync("src/electron/preload.ts", "utf-8");
  const sharedSource = fs.readFileSync("src/shared/types.ts", "utf-8");

  const preloadChannels = extractChannelMap(preloadSource, "const IPC_CHANNELS = {");
  const sharedChannels = extractChannelMap(sharedSource, "export const IPC_CHANNELS = {");

  it("matches between preload and shared constants", () => {
    const preloadKeys = Object.keys(preloadChannels).sort();
    const sharedKeys = Object.keys(sharedChannels).sort();

    expect(preloadKeys).toEqual(sharedKeys);

    for (const key of sharedKeys) {
      expect(preloadChannels[key]).toBe(sharedChannels[key]);
    }
  });
});
