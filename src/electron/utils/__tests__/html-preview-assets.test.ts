import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inlineLocalHtmlPreviewAssets } from "../html-preview-assets";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-html-preview-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

describe("inlineLocalHtmlPreviewAssets", () => {
  it("inlines same-workspace stylesheet and script references", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const pageDir = path.join(workspace, ".cowork");
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(path.join(pageDir, "styles.css"), "body { color: rebeccapurple; }");
    await fs.writeFile(path.join(pageDir, "script.js"), "document.body.dataset.ready = 'true';");
    const htmlPath = path.join(pageDir, "index.html");
    const html = [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<link rel="stylesheet" href="styles.css">',
      "</head>",
      "<body>",
      '<script src="script.js"></script>',
      "</body>",
      "</html>",
    ].join("\n");

    const result = await inlineLocalHtmlPreviewAssets({
      htmlContent: html,
      htmlFilePath: htmlPath,
      workspaceRoot: workspace,
    });

    expect(result).toContain('<style data-cowork-inline-asset="styles.css">');
    expect(result).toContain("body { color: rebeccapurple; }");
    expect(result).toContain('<script data-cowork-inline-asset="script.js">');
    expect(result).toContain("document.body.dataset.ready = 'true';");
    expect(result).not.toContain('href="styles.css"');
    expect(result).not.toContain('src="script.js"');
  });

  it("leaves external and parent-traversal assets alone", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const pageDir = path.join(workspace, ".cowork");
    await fs.mkdir(pageDir, { recursive: true });
    const htmlPath = path.join(pageDir, "index.html");
    const html = [
      '<link rel="stylesheet" href="https://example.com/app.css">',
      '<link rel="stylesheet" href="../outside.css">',
      '<script src="//example.com/app.js"></script>',
      '<script src="../outside.js"></script>',
    ].join("\n");

    const result = await inlineLocalHtmlPreviewAssets({
      htmlContent: html,
      htmlFilePath: htmlPath,
      workspaceRoot: workspace,
    });

    expect(result).toBe(html);
  });

  it("inlines root-relative built asset references from the HTML directory", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const distDir = path.join(workspace, "dist");
    await fs.mkdir(path.join(distDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(distDir, "assets", "app.css"), "body { color: red; }");
    await fs.writeFile(
      path.join(distDir, "assets", "app.js"),
      "document.body.dataset.app = 'ready';",
    );
    const htmlPath = path.join(distDir, "index.html");
    const html = [
      '<link rel="stylesheet" href="/assets/app.css">',
      '<script src="/assets/app.js"></script>',
    ].join("\n");

    const result = await inlineLocalHtmlPreviewAssets({
      htmlContent: html,
      htmlFilePath: htmlPath,
      workspaceRoot: workspace,
    });

    expect(result).toContain("body { color: red; }");
    expect(result).toContain("document.body.dataset.app = 'ready';");
    expect(result).not.toContain('href="/assets/app.css"');
    expect(result).not.toContain('src="/assets/app.js"');
  });

  it("does not inline symlinked assets that resolve outside the workspace", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    const pageDir = path.join(workspace, ".cowork");
    await fs.mkdir(pageDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.css"), "body { background: secret; }");
    await fs.symlink(path.join(outside, "secret.css"), path.join(pageDir, "secret.css"));
    const htmlPath = path.join(pageDir, "index.html");
    const html = '<link rel="stylesheet" href="secret.css">';

    const result = await inlineLocalHtmlPreviewAssets({
      htmlContent: html,
      htmlFilePath: htmlPath,
      workspaceRoot: workspace,
    });

    expect(result).toBe(html);
    expect(result).not.toContain("background: secret");
  });
});
