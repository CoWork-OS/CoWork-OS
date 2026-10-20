import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { createLogger, loadConfigFromFile, optimizeDeps, resolveConfig } from "vite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const viteConfigPath = path.join(repositoryRoot, "vite.config.mts");
const webViteConfigPath = path.join(repositoryRoot, "vite.web.config.mts");
const require = createRequire(import.meta.url);

describe("renderer Vite configuration", () => {
  it("preserves the Electron renderer output contract under Vite 8", async () => {
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      viteConfigPath,
      repositoryRoot,
    );

    expect(loaded).toBeDefined();
    expect(loaded?.config.root).toBe(path.join(repositoryRoot, "src/renderer"));
    expect(loaded?.config.base).toBe("./");
    expect(loaded?.config.build?.outDir).toBe(path.join(repositoryRoot, "dist/renderer"));
    expect(loaded?.config.build?.emptyOutDir).toBe(true);
    expect(loaded?.config.server?.host).toBe("127.0.0.1");
    expect(loaded?.config.server?.strictPort).toBe(true);
  });

  it("serves font and PDF worker assets from shared dependency packages without exposing all dependencies", async () => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      viteConfigPath,
      repositoryRoot,
    );
    const allowedPaths = loaded?.config.server?.fs?.allow ?? [];
    const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const fontRoot = path.dirname(require.resolve("@fontsource/montserrat/package.json"));

    expect(allowedPaths).toContain(pdfRoot);
    expect(allowedPaths).toContain(fontRoot);
    expect(allowedPaths).not.toContain(path.dirname(pdfRoot));
  });
});

describe("browser Vite configuration", () => {
  it("keeps the browser output separate from the Electron renderer", async () => {
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      webViteConfigPath,
      repositoryRoot,
    );

    expect(loaded).toBeDefined();
    expect(loaded?.config.root).toBe(path.join(repositoryRoot, "src/renderer-web"));
    expect(loaded?.config.base).toBe("./");
    expect(loaded?.config.build?.outDir).toBe(path.join(repositoryRoot, "dist/web"));
    expect(loaded?.config.build?.emptyOutDir).toBe(true);
  });
});

describe.each([viteConfigPath, webViteConfigPath])(
  "ELK development dependencies in %s",
  (configFile) => {
    it("optimizes a dependency importing the ELK alias without bundling its worker URL", async () => {
      const fixtureRoot = mkdtempSync(path.join(tmpdir(), "cowork-elk-dependency-test-"));
      const packageRoot = path.join(fixtureRoot, "node_modules/elk-optimizer-fixture");
      try {
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "elk-optimizer-fixture", type: "module", main: "index.js" }),
        );
        writeFileSync(
          path.join(packageRoot, "index.js"),
          'export { default } from "elkjs/lib/elk.bundled.js";',
        );
        const config = await resolveConfig(
          {
            configFile,
            root: fixtureRoot,
            cacheDir: path.join(fixtureRoot, "cache"),
            customLogger: createLogger("silent"),
            optimizeDeps: { include: ["elk-optimizer-fixture"], noDiscovery: true },
          },
          "serve",
        );

        const optimized = await optimizeDeps(config, true);
        const fixture = optimized.optimized["elk-optimizer-fixture"];
        expect(fixture).toBeDefined();
        expect(readFileSync(fixture.file, "utf8")).toContain("elkjs/lib/elk.bundled.js");
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  },
);
