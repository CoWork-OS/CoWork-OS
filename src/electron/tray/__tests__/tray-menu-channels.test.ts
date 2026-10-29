import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The app menu (⌘N, ⌘,) and the tray menu once sent "tray:new-task" style
// strings while the renderer listened on IPC_CHANNELS ("tray:newTask"), so the
// commands did nothing. Every message they send must name a channel constant.
const SOURCES = ["../TrayManager.ts", "../../main.ts"].map((relative) =>
  path.resolve(__dirname, relative),
);

describe("menu and tray commands", () => {
  it.each(SOURCES)("%s sends only IPC_CHANNELS constants to the main window", (file) => {
    const source = fs.readFileSync(file, "utf8");
    const literalSends = source.match(/(?:webContents\.send|sendToMainWindow)\(\s*["'`]/g) ?? [];
    expect(literalSends).toEqual([]);
  });
});
