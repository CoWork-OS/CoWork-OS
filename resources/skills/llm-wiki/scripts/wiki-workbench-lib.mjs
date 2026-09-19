import fs from "node:fs";
import path from "node:path";

export const CONTENT_DIRS = [
  "entities",
  "concepts",
  "projects",
  "comparisons",
  "queries",
  "maps",
  "_meta",
];

export const ROOT_FILES = ["SCHEMA.md", "index.md", "log.md", "inbox.md"];

export const RAW_DIR_BY_KIND = {
  article: "raw/articles",
  paper: "raw/papers",
  repo: "raw/repos",
  image: "raw/assets",
  asset: "raw/assets",
  dataset: "raw/datasets",
};

export const OUTPUT_DIR_BY_KIND = {
  marp: "outputs/slides",
  chart: "outputs/charts",
};

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".xml",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".java",
  ".go",
  ".rs",
  ".ipynb",
  ".tex",
  ".css",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".tif",
  ".tiff",
]);

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

export function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(content), "utf8");
}

export function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function listFilesRecursive(dirPath, options = {}) {
  const maxDepth =
    typeof options.maxDepth === "number" && Number.isFinite(options.maxDepth)
      ? options.maxDepth
      : Number.POSITIVE_INFINITY;
  const skip = new Set(options.skip || []);
  if (!fs.existsSync(dirPath)) return [];

  const output = [];
  const visit = (currentPath, depth) => {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  };

  visit(dirPath, 0);
  return output;
}

export function slugify(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[?#].*$/, "")
      .replace(/\\/g, "/")
      .replace(/\.git$/i, "")
      .replace(/[^a-z0-9/_-]+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/-+/g, "-")
      .replace(/^[-/]+|[-/]+$/g, "") || "item"
  );
}

export function getSafeFileStem(input, fallback = "item") {
  const stem = slugify(input).split("/").filter(Boolean).slice(-1)[0];
  return stem || fallback;
}

export function isUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

export function isImageExtension(ext) {
  return IMAGE_EXTENSIONS.has(String(ext || "").toLowerCase());
}

export function isTextExtension(ext) {
  return TEXT_EXTENSIONS.has(String(ext || "").toLowerCase());
}

export function normalizeRelativePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function guessTextExtensionFromContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("markdown")) return ".md";
  if (value.includes("html")) return ".html";
  if (value.includes("json")) return ".json";
  if (value.includes("xml")) return ".xml";
  if (value.includes("csv")) return ".csv";
  if (value.includes("plain")) return ".txt";
  return ".txt";
}

export function parseFrontmatter(text) {
  const normalized = String(text || "");
  if (!normalized.startsWith("---\n")) {
    return { fields: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { fields: {}, body: normalized };
  }
  const fields = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      fields[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    } else {
      fields[key] = rawValue.trim();
    }
  }
  return {
    fields,
    body: normalized.slice(end + 5),
  };
}

export function getTitleFromMarkdown(filePath) {
  try {
    const parsed = parseFrontmatter(readText(filePath));
    if (typeof parsed.fields.title === "string" && parsed.fields.title.trim()) {
      return parsed.fields.title.trim();
    }
  } catch {
    // Ignore malformed or unreadable files.
  }
  return path.basename(filePath, path.extname(filePath));
}

export function isoNow() {
  return new Date().toISOString();
}

export function inferSourceKind(source, explicitKind = "auto") {
  const preferred = String(explicitKind || "auto")
    .trim()
    .toLowerCase();
  if (preferred && preferred !== "auto") {
    return preferred;
  }

  const sourceValue = String(source || "").trim();
  const lower = sourceValue.toLowerCase();
  const ext = path.extname(lower);

  try {
    if (sourceValue && fs.existsSync(sourceValue)) {
      const stats = fs.statSync(sourceValue);
      if (stats.isDirectory()) return "repo";
    }
  } catch {
    // Ignore local stat errors for inference.
  }

  if (isImageExtension(ext)) return "image";
  if (ext === ".pdf" || /(?:arxiv|paper|doi\.org)/i.test(lower)) return "paper";
  if (/github\.com|gitlab\.com|bitbucket\.org|\.git(?:$|[?#])/.test(lower)) return "repo";
  return "article";
}

export function buildRawTargetPath(vaultPath, kind, slug, extension = "") {
  const dir = RAW_DIR_BY_KIND[kind] || RAW_DIR_BY_KIND.article;
  if (kind === "image" || kind === "asset") {
    return path.join(vaultPath, dir, `${getSafeFileStem(slug)}${extension}`);
  }
  return path.join(vaultPath, dir, getSafeFileStem(slug));
}

export function buildOutputTargetPath(vaultPath, kind, fileName) {
  const dir = OUTPUT_DIR_BY_KIND[kind];
  if (!dir) {
    throw new Error(`Unsupported output kind: ${kind}`);
  }
  return path.join(vaultPath, dir, fileName);
}

export function collectVaultMarkdownFiles(vaultPath, scope = "wiki") {
  const files = [];
  if (scope === "wiki" || scope === "all") {
    for (const rootFile of ROOT_FILES) {
      const fullPath = path.join(vaultPath, rootFile);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        files.push(fullPath);
      }
    }
    for (const dirName of CONTENT_DIRS) {
      files.push(
        ...listFilesRecursive(path.join(vaultPath, dirName)).filter((candidate) =>
          candidate.toLowerCase().endsWith(".md"),
        ),
      );
    }
    files.push(
      ...listFilesRecursive(path.join(vaultPath, "outputs", "slides")).filter((candidate) =>
        candidate.toLowerCase().endsWith(".md"),
      ),
    );
  }

  if (scope === "raw" || scope === "all") {
    files.push(
      ...listFilesRecursive(path.join(vaultPath, "raw")).filter((candidate) => {
        const ext = path.extname(candidate).toLowerCase();
        return isTextExtension(ext) || ext === ".md";
      }),
    );
  }

  return Array.from(new Set(files.map((filePath) => path.resolve(filePath))));
}
