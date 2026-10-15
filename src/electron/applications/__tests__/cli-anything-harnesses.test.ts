import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cliAnythingRoutingPrompt,
  findCliAnythingHarnesses,
  resetCliAnythingHarnessCache,
} from "../cli-anything-harnesses";
import { applicationWorkerPrompt } from "../application-worker-prompt";

let root: string;

function bin(dir: string, ...names: string[]): string {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(full, name), "#!/bin/sh\n", { mode: 0o755 });
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-anything-"));
  resetCliAnythingHarnessCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetCliAnythingHarnessCache();
});

describe("findCliAnythingHarnesses", () => {
  it("lists harness commands on PATH, sorted and deduplicated", () => {
    const a = bin("a", "cli-anything-libreoffice", "cli-anything-gimp", "gimp", "cli-anything-");
    const b = bin(
      "b",
      "cli-anything-gimp",
      "cli-anything-hub-notes.txt.bak",
      "cli-anything-Blender",
    );
    const home = path.join(root, "home");
    expect(
      findCliAnythingHarnesses({ pathEnv: [a, b, "relative/bin"].join(path.delimiter), home }),
    ).toEqual(["cli-anything-gimp", "cli-anything-libreoffice"]);
  });

  it("gives the absolute path for harnesses only in ~/.local/bin", () => {
    const onPath = bin("a", "cli-anything-gimp");
    const home = path.join(root, "home");
    const userBin = bin(
      path.join("home", ".local", "bin"),
      "cli-anything-gimp",
      "cli-anything-blender",
    );
    expect(findCliAnythingHarnesses({ pathEnv: onPath, home })).toEqual([
      path.join(userBin, "cli-anything-blender"),
      "cli-anything-gimp",
    ]);
    resetCliAnythingHarnessCache();
    expect(findCliAnythingHarnesses({ pathEnv: userBin, home })).toEqual([
      "cli-anything-blender",
      "cli-anything-gimp",
    ]);
  });

  it("skips missing directories", () => {
    expect(
      findCliAnythingHarnesses({ pathEnv: path.join(root, "nope"), home: path.join(root, "h") }),
    ).toEqual([]);
  });

  it("reuses a scan for a minute, then rescans", () => {
    const dir = bin("a");
    const home = path.join(root, "home");
    expect(findCliAnythingHarnesses({ pathEnv: dir, home, now: 0 })).toEqual([]);
    bin("a", "cli-anything-gimp");
    expect(findCliAnythingHarnesses({ pathEnv: dir, home, now: 59_000 })).toEqual([]);
    expect(findCliAnythingHarnesses({ pathEnv: dir, home, now: 60_000 })).toEqual([
      "cli-anything-gimp",
    ]);
  });
});

describe("cliAnythingRoutingPrompt", () => {
  it("names installed harnesses and keeps native_app for window work", () => {
    const prompt = cliAnythingRoutingPrompt(["cli-anything-gimp", "cli-anything-libreoffice"]);
    expect(prompt).toContain(
      "prefer a headless CLI-Anything harness through run_command over native_app",
    );
    expect(prompt).toContain("Installed: cli-anything-gimp, cli-anything-libreoffice.");
    expect(prompt).toContain(
      "Use native_app only when the user asks to operate or watch the app's window",
    );
  });

  it("asks before installing when none are present", () => {
    expect(cliAnythingRoutingPrompt([])).toContain(
      "None installed; installing one runs third-party code, so ask the user first.",
    );
  });
});

describe.runIf(process.platform === "darwin")("applicationWorkerPrompt CLI routing", () => {
  it("adds harness routing by default", () => {
    expect(applicationWorkerPrompt()).toContain("CLI APPLICATION HARNESSES");
  });

  it("omits harness routing when the task forbids scripting", () => {
    const prompt = applicationWorkerPrompt({ forbidsScripting: true });
    expect(prompt).toContain("BACKGROUND APPLICATIONS");
    expect(prompt).not.toContain("CLI APPLICATION HARNESSES");
  });
});
