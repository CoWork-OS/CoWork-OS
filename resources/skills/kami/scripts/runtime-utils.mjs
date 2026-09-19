import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export function scriptDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function createAppRequire(importMetaUrl) {
  const dir = scriptDir(importMetaUrl);
  const candidates = [
    path.resolve(dir, "../../../../package.json"),
    path.resolve(dir, "../../../app.asar/package.json"),
    path.resolve(dir, "../../../app.asar.unpacked/package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return createRequire(candidate);
    }
  }

  return createRequire(importMetaUrl);
}

export function loadNodeRuntime(importMetaUrl) {
  const requireFromApp = createAppRequire(importMetaUrl);
  const pptxgenjsModule = requireFromApp("pptxgenjs");
  const playwrightModule = requireFromApp("playwright");

  return {
    PptxGenJS: pptxgenjsModule.default || pptxgenjsModule,
    chromium:
      playwrightModule.chromium ||
      playwrightModule.default?.chromium ||
      playwrightModule.playwright?.chromium,
  };
}

function which(command) {
  try {
    return execFileSync("which", [command], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export function resolveBrowserExecutable() {
  const envCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.BRAVE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ]
    .map((value) => value?.trim())
    .filter(Boolean);

  const platformCandidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : process.platform === "win32"
        ? [
            process.env.LOCALAPPDATA
              ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
              : "",
            process.env.LOCALAPPDATA
              ? path.join(process.env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe")
              : "",
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
            "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
            "/snap/bin/brave",
          ];

  const discoveredCommands =
    process.platform === "win32"
      ? []
      : [
          which("google-chrome"),
          which("google-chrome-stable"),
          which("chromium"),
          which("chromium-browser"),
          which("microsoft-edge"),
          which("brave-browser"),
        ].filter(Boolean);

  for (const candidate of [...envCandidates, ...platformCandidates, ...discoveredCommands]) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function loadDeck(sourcePath) {
  const href = `${pathToFileURL(sourcePath).href}?t=${Date.now()}`;
  const imported = await import(href);
  const deck = imported.default || imported.deck;
  if (!deck || !Array.isArray(deck.slides)) {
    throw new Error("Deck source must export a default object with a slides array.");
  }
  return deck;
}

export function ensureNoPlaceholders(sourcePath) {
  const text = fs.readFileSync(sourcePath, "utf-8");
  const placeholders = Array.from(new Set(text.match(/\{\{[^}]+\}\}/g) || []));
  if (placeholders.length > 0) {
    throw new Error(
      `Unfilled placeholders in ${path.basename(sourcePath)}: ${placeholders.join(", ")}`,
    );
  }
}
