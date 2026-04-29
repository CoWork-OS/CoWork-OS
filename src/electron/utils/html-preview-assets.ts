import * as path from "path";
import * as fs from "fs/promises";

const MAX_INLINE_ASSET_BYTES = 1024 * 1024;
const MAX_TOTAL_INLINE_ASSET_BYTES = 2 * 1024 * 1024;

type InlineHtmlPreviewAssetsOptions = {
  htmlContent: string;
  htmlFilePath: string;
  workspaceRoot?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
};

const STYLE_LINK_RE = /<link\b[^>]*>/gi;
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/script>/gi;
const ATTR_RE = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(["'])(.*?)\2/g;

function getAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(ATTR_RE)) {
    attrs[match[1].toLowerCase()] = match[3];
  }
  return attrs;
}

function stripUrlDecorators(rawUrl: string): string {
  return rawUrl.split("#", 1)[0].split("?", 1)[0].trim();
}

function shouldInlineAsset(rawUrl: string): boolean {
  const assetUrl = stripUrlDecorators(rawUrl);
  if (!assetUrl) return false;
  if (assetUrl.startsWith("\\")) return false;
  if (assetUrl.includes("..")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(assetUrl) && !assetUrl.startsWith("//");
}

function resolveAssetPath(rawUrl: string, baseDir: string, workspaceRoot?: string): string | null {
  if (!shouldInlineAsset(rawUrl)) return null;
  const assetUrl = stripUrlDecorators(rawUrl);
  const resolved = path.resolve(
    baseDir,
    assetUrl.startsWith("/") ? `.${assetUrl}` : assetUrl,
  );
  if (!workspaceRoot) return resolved;
  const relative = path.relative(path.resolve(workspaceRoot), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function escapeStyleContent(content: string): string {
  return content.replace(/<\/style/gi, "<\\/style");
}

function escapeScriptContent(content: string): string {
  return content.replace(/<\/script/gi, "<\\/script");
}

function escapeAttributeContent(content: string): string {
  return content.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function readInlineableAsset(
  assetPath: string,
  state: {
    totalBytes: number;
    readTextFile: (filePath: string) => Promise<string>;
    statFile: (filePath: string) => Promise<{ size: number }>;
  },
): Promise<string | null> {
  const stat = await state.statFile(assetPath);
  if (stat.size > MAX_INLINE_ASSET_BYTES) return null;
  if (state.totalBytes + stat.size > MAX_TOTAL_INLINE_ASSET_BYTES) return null;
  const content = await state.readTextFile(assetPath);
  state.totalBytes += stat.size;
  return content;
}

export async function inlineLocalHtmlPreviewAssets({
  htmlContent,
  htmlFilePath,
  workspaceRoot,
  readTextFile = (filePath) => fs.readFile(filePath, "utf-8"),
  statFile = (filePath) => fs.stat(filePath),
}: InlineHtmlPreviewAssetsOptions): Promise<string> {
  const baseDir = path.dirname(htmlFilePath);
  const state = { totalBytes: 0, readTextFile, statFile };
  let output = htmlContent;

  const styleReplacements: Array<{ tag: string; replacement: string }> = [];
  for (const match of output.matchAll(STYLE_LINK_RE)) {
    const tag = match[0];
    const attrs = getAttributes(tag);
    const isStylesheet = attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet");
    if (!isStylesheet || !attrs.href) {
      styleReplacements.push({ tag, replacement: tag });
      continue;
    }
    const assetPath = resolveAssetPath(attrs.href, baseDir, workspaceRoot);
    if (!assetPath) {
      styleReplacements.push({ tag, replacement: tag });
      continue;
    }
    try {
      const css = await readInlineableAsset(assetPath, state);
      if (css === null) {
        styleReplacements.push({ tag, replacement: tag });
        continue;
      }
      styleReplacements.push({
        tag,
        replacement:
          `<style data-cowork-inline-asset="${escapeAttributeContent(attrs.href)}">\n` +
          `${escapeStyleContent(css)}\n</style>`,
      });
    } catch {
      styleReplacements.push({ tag, replacement: tag });
    }
  }

  for (const { tag, replacement } of styleReplacements) {
    output = output.replace(tag, replacement);
  }

  const scriptReplacements: Array<{ tag: string; replacement: string }> = [];
  for (const match of output.matchAll(SCRIPT_SRC_RE)) {
    const tag = match[0];
    const scriptUrl = match[2];
    const assetPath = resolveAssetPath(scriptUrl, baseDir, workspaceRoot);
    if (!assetPath) {
      scriptReplacements.push({ tag, replacement: tag });
      continue;
    }
    try {
      const js = await readInlineableAsset(assetPath, state);
      if (js === null) {
        scriptReplacements.push({ tag, replacement: tag });
        continue;
      }
      scriptReplacements.push({
        tag,
        replacement:
          `<script data-cowork-inline-asset="${escapeAttributeContent(scriptUrl)}">\n` +
          `${escapeScriptContent(js)}\n</script>`,
      });
    } catch {
      scriptReplacements.push({ tag, replacement: tag });
    }
  }

  for (const { tag, replacement } of scriptReplacements) {
    output = output.replace(tag, replacement);
  }

  return output;
}
