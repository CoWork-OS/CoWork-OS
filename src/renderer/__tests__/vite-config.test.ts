import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const viteConfigPath = path.join(repositoryRoot, "vite.config.ts");

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
});
