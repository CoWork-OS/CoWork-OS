import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildWebPagePreviewFromPath } from "../web-preview";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-preview-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

describe("web page preview extraction", () => {
  it("reads a discovered manifest once so one-shot authorization stays valid", async () => {
    const manifest = path.join(tempRoot, "package.json");
    const canonicalManifest = path.join(await fs.realpath(tempRoot), "package.json");
    const htmlPath = path.join(tempRoot, "index.html");
    await fs.writeFile(manifest, '{"dependencies":{"react":"1"}}');
    await fs.writeFile(htmlPath, "<main>authorized app</main>");
    let manifestReads = 0;
    const preview = await buildWebPagePreviewFromPath(htmlPath, tempRoot, {
      authorizeReadPath: async (filePath) => {
        if (filePath === canonicalManifest && ++manifestReads > 1)
          throw new Error("grant consumed");
        return fs.realpath(filePath);
      },
    });
    expect(preview.canPreview).toBe(true);
    expect(preview.framework).toBe("react");
    expect(manifestReads).toBe(1);
  });
  it("keeps authorized local assets and missing optional assets compatible", async () => {
    const htmlPath = path.join(tempRoot, "index.html");
    await fs.mkdir(path.join(tempRoot, "assets"));
    await fs.writeFile(path.join(tempRoot, "assets/style.css"), "body { color: teal; }");
    await fs.writeFile(path.join(tempRoot, "app.js"), "document.title = 'ready';");
    await fs.writeFile(
      htmlPath,
      '<link rel="stylesheet" href="/assets/style.css?v=1"><script src="app.js#x"></script><script src="missing.js"></script>',
    );
    const authorizeReadPath = vi.fn((filePath: string) => fs.realpath(filePath));
    const preview = await buildWebPagePreviewFromPath(htmlPath, tempRoot, { authorizeReadPath });
    expect(preview.htmlContent).toContain("color: teal");
    expect(preview.htmlContent).toContain("document.title = 'ready'");
    expect(preview.htmlContent).toContain('src="missing.js"');
    expect(authorizeReadPath.mock.calls.map(([filePath]) => filePath)).toEqual([
      await fs.realpath(htmlPath),
      await fs.realpath(path.join(tempRoot, "assets/style.css")),
      await fs.realpath(path.join(tempRoot, "app.js")),
    ]);
  });

  it("authorizes discovered built HTML rather than only its project manifest", async () => {
    await fs.mkdir(path.join(tempRoot, "dist"));
    await fs.writeFile(path.join(tempRoot, "package.json"), '{"dependencies":{"react":"1"}}');
    await fs.writeFile(path.join(tempRoot, "dist/index.html"), "<main>private</main>");
    await expect(
      buildWebPagePreviewFromPath(tempRoot, tempRoot, {
        authorizeReadPath: async (filePath) => {
          if (filePath.endsWith("index.html")) throw new Error("built entry denied");
          return fs.realpath(filePath);
        },
      }),
    ).rejects.toThrow("built entry denied");
  });
  it("returns sandbox-ready HTML content with local assets inlined", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "styles.css"), "body { color: teal; }");
    const htmlPath = path.join(workspace, "index.html");
    await fs.writeFile(
      htmlPath,
      '<!doctype html><link rel="stylesheet" href="styles.css"><main>Hello</main>',
    );

    const preview = await buildWebPagePreviewFromPath(htmlPath, workspace);

    expect(preview.canPreview).toBe(true);
    expect(preview.format).toBe("html");
    expect(preview.previewMode).toBe("sandboxed_iframe");
    expect(preview.htmlContent).toContain('data-cowork-inline-asset="styles.css"');
    expect(preview.htmlContent).toContain("body { color: teal; }");
  });

  it("resolves built React output from common build directories", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const project = path.join(workspace, "app");
    await fs.mkdir(path.join(project, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" }, devDependencies: { vite: "^5.0.0" } }),
    );
    await fs.writeFile(path.join(project, "dist", "index.html"), "<main>Built app</main>");

    const preview = await buildWebPagePreviewFromPath(project, workspace);

    expect(preview.canPreview).toBe(true);
    expect(preview.framework).toBe("vite");
    expect(preview.sourcePath).toBe(path.join(project, "dist", "index.html"));
    expect(preview.htmlContent).toContain("Built app");
  });

  it("returns a structured unavailable preview for React projects without built output", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const project = path.join(workspace, "app");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
    );

    const preview = await buildWebPagePreviewFromPath(project, workspace);

    expect(preview.canPreview).toBe(false);
    expect(preview.framework).toBe("react");
    expect(preview.previewMessage).toContain("no built index.html");
  });
});
