import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * CLI-Anything harnesses (github.com/HKUDS/CLI-Anything) drive a desktop app's
 * real backend headless and print JSON. For file work they are preferred over
 * native_app window control; the bundled cli-anything skill covers usage.
 */
const HARNESS_NAME = /^cli-anything-[a-z0-9][a-z0-9-]*$/;
const CACHE_TTL_MS = 60_000;

let cache: { key: string; at: number; harnesses: string[] } | undefined;

function pathDirs(pathEnv: string): string[] {
  return pathEnv
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry));
}

function harnessesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => HARNESS_NAME.test(name));
  } catch {
    return [];
  }
}

/**
 * Installed harnesses, sorted: the bare command when it is on PATH, otherwise
 * its absolute path in the uv/pip user bin dir (~/.local/bin), which a shell
 * started from the app may not have on PATH.
 */
export function findCliAnythingHarnesses(
  options: { pathEnv?: string; home?: string; now?: number } = {},
): string[] {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const home = options.home ?? os.homedir();
  const now = options.now ?? Date.now();
  const key = `${pathEnv}\0${home}`;
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.harnesses;

  const dirs = pathDirs(pathEnv);
  const found = new Map<string, string>();
  for (const dir of dirs) {
    for (const name of harnessesIn(dir)) found.set(name, name);
  }
  if (home) {
    const userBin = path.join(home, ".local", "bin");
    if (!dirs.includes(userBin)) {
      for (const name of harnessesIn(userBin)) {
        if (!found.has(name)) found.set(name, path.join(userBin, name));
      }
    }
  }
  const harnesses = Array.from(found.keys())
    .sort()
    .map((name) => found.get(name) as string);
  cache = { key, at: now, harnesses };
  return harnesses;
}

export function resetCliAnythingHarnessCache(): void {
  cache = undefined;
}

/** Routing guidance that prefers headless harnesses over native_app for file work. */
export function cliAnythingRoutingPrompt(harnesses: string[]): string {
  const installed =
    harnesses.length > 0
      ? `Installed: ${harnesses.join(", ")}.`
      : "None installed; installing one runs third-party code, so ask the user first.";
  return `CLI APPLICATION HARNESSES
To create, edit or export a file with a desktop app (LibreOffice documents, GIMP images, Blender, Inkscape, Audacity, Draw.io and similar), prefer a headless CLI-Anything harness through run_command over native_app window control, following the cli-anything skill. ${installed} Use native_app only when the user asks to operate or watch the app's window, or the harness lacks the operation.`;
}
