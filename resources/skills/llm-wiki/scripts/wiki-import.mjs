#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildRawTargetPath,
  ensureDir,
  getSafeFileStem,
  guessTextExtensionFromContentType,
  inferSourceKind,
  isImageExtension,
  isTextExtension,
  isUrl,
  isoNow,
  listFilesRecursive,
  normalizeRelativePath,
  slugify,
  stripHtml,
  writeJson,
  writeText,
} from "./wiki-workbench-lib.mjs";

function parseArgs(argv) {
  const args = {
    kind: "auto",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--vault") {
      args.vault = argv[++i];
      continue;
    }
    if (token === "--source") {
      args.source = argv[++i];
      continue;
    }
    if (token === "--kind") {
      args.kind = argv[++i];
      continue;
    }
    if (token === "--title") {
      args.title = argv[++i];
      continue;
    }
    if (token === "--body-file") {
      args.bodyFile = argv[++i];
      continue;
    }
  }
  if (!args.vault) {
    throw new Error("Missing --vault <path>");
  }
  if (!args.source) {
    throw new Error("Missing --source <path-or-url>");
  }
  return args;
}

async function fetchRemoteSource(source) {
  const response = await fetch(source, {
    headers: {
      "user-agent": "cowork-os-llm-wiki-import/1.0",
      accept: "text/html, text/markdown, text/plain, application/json, image/*;q=0.8, */*;q=0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch source (${response.status} ${response.statusText})`);
  }
  const contentType = String(response.headers.get("content-type") || "");
  const bytes = Buffer.from(await response.arrayBuffer());
  return { contentType, bytes };
}

function resolveTitle(args, source, kind) {
  if (typeof args.title === "string" && args.title.trim()) {
    return args.title.trim();
  }
  const sourceValue = String(source || "").trim();
  if (isUrl(sourceValue)) {
    const withoutHash = sourceValue.replace(/[?#].*$/, "");
    const tail = withoutHash.split("/").filter(Boolean).slice(-1)[0];
    if (tail) return tail;
  }
  if (fs.existsSync(sourceValue)) {
    return path.basename(sourceValue);
  }
  return `${kind}-${getSafeFileStem(sourceValue)}`;
}

function buildRepoTree(rootPath) {
  const files = listFilesRecursive(rootPath, {
    maxDepth: 4,
    skip: [".git", "node_modules", "dist", "build", ".next", ".turbo"],
  });
  const relPaths = files
    .map((filePath) => normalizeRelativePath(path.relative(rootPath, filePath)))
    .filter(Boolean)
    .slice(0, 500);
  return `${relPaths.join("\n")}${relPaths.length > 0 ? "\n" : ""}`;
}

function copyOptionalReadme(sourceDir, targetDir) {
  const readme = fs
    .readdirSync(sourceDir)
    .find((entry) => /^readme(\.[a-z0-9._-]+)?$/i.test(entry));
  if (!readme) return null;
  const sourcePath = path.join(sourceDir, readme);
  const targetPath = path.join(targetDir, `README.snapshot${path.extname(readme) || ".md"}`);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function writeTextCapture(targetDir, baseName, extension, body, metadata) {
  ensureDir(targetDir);
  const targetPath = path.join(targetDir, `${baseName}${extension}`);
  if (extension === ".html") {
    writeText(targetPath, body);
    writeText(path.join(targetDir, `${baseName}.txt`), `${stripHtml(body)}\n`);
  } else {
    writeText(targetPath, body.endsWith("\n") ? body : `${body}\n`);
  }
  writeJson(path.join(targetDir, "source.json"), metadata);
  return targetPath;
}

async function importStructuredSource({ vaultPath, kind, source, title, bodyFile }) {
  const slug = slugify(title || source);
  const targetDir = buildRawTargetPath(vaultPath, kind, slug);
  ensureDir(targetDir);

  const metadata = {
    kind,
    title,
    source,
    importedAt: isoNow(),
  };

  if (bodyFile) {
    const ext = path.extname(bodyFile).toLowerCase() || ".txt";
    const targetPath = path.join(targetDir, `capture${ext}`);
    fs.copyFileSync(bodyFile, targetPath);
    writeJson(path.join(targetDir, "source.json"), metadata);
    return {
      kind,
      targetPath,
      metadataPath: path.join(targetDir, "source.json"),
    };
  }

  if (fs.existsSync(source)) {
    const stats = fs.statSync(source);
    if (stats.isDirectory()) {
      if (kind !== "repo") {
        throw new Error("Only repo imports support directory sources.");
      }
      const treePath = path.join(targetDir, "tree.txt");
      writeText(treePath, buildRepoTree(source));
      const readmePath = copyOptionalReadme(source, targetDir);
      writeJson(path.join(targetDir, "source.json"), {
        ...metadata,
        sourceType: "directory",
        readmeSnapshot: readmePath ? path.basename(readmePath) : null,
      });
      return {
        kind,
        targetPath: targetDir,
        metadataPath: path.join(targetDir, "source.json"),
        treePath,
        readmePath,
      };
    }

    const ext = path.extname(source).toLowerCase() || ".txt";
    const targetPath = path.join(targetDir, `capture${ext}`);
    fs.copyFileSync(source, targetPath);
    writeJson(path.join(targetDir, "source.json"), {
      ...metadata,
      sourceType: "file",
      originalExtension: ext,
    });
    return {
      kind,
      targetPath,
      metadataPath: path.join(targetDir, "source.json"),
    };
  }

  if (!isUrl(source)) {
    throw new Error(`Source does not exist and is not a URL: ${source}`);
  }

  const fetched = await fetchRemoteSource(source);
  const ext = isTextExtension(path.extname(source).toLowerCase())
    ? path.extname(source).toLowerCase()
    : guessTextExtensionFromContentType(fetched.contentType);
  const body = ext === ".json" ? fetched.bytes.toString("utf8") : fetched.bytes.toString("utf8");
  const targetPath = writeTextCapture(targetDir, "capture", ext || ".txt", body, {
    ...metadata,
    sourceType: "url",
    contentType: fetched.contentType,
  });

  return {
    kind,
    targetPath,
    metadataPath: path.join(targetDir, "source.json"),
  };
}

async function importImageSource({ vaultPath, kind, source, title }) {
  const sourceValue = String(source || "").trim();
  const explicitExt = path.extname(sourceValue).toLowerCase();
  const stem = getSafeFileStem(title || sourceValue, kind);
  let bytes;
  let contentType = "";
  let extension = explicitExt;

  if (fs.existsSync(sourceValue)) {
    bytes = fs.readFileSync(sourceValue);
    if (!extension) {
      throw new Error("Local image imports require a file extension.");
    }
  } else if (isUrl(sourceValue)) {
    const fetched = await fetchRemoteSource(sourceValue);
    bytes = fetched.bytes;
    contentType = fetched.contentType;
    if (!extension) {
      if (/image\/svg\+xml/i.test(contentType)) extension = ".svg";
      else if (/image\/png/i.test(contentType)) extension = ".png";
      else if (/image\/jpe?g/i.test(contentType)) extension = ".jpg";
      else if (/image\/webp/i.test(contentType)) extension = ".webp";
      else if (/image\/gif/i.test(contentType)) extension = ".gif";
    }
  } else {
    throw new Error(`Image source does not exist and is not a URL: ${sourceValue}`);
  }

  if (!isImageExtension(extension)) {
    throw new Error(`Unsupported image extension: ${extension || "(missing extension)"}`);
  }

  const targetPath = buildRawTargetPath(vaultPath, kind, stem, extension);
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, bytes);
  const metadataPath = `${targetPath}.source.json`;
  writeJson(metadataPath, {
    kind,
    title,
    source,
    importedAt: isoNow(),
    contentType,
  });
  return {
    kind,
    targetPath,
    metadataPath,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const vaultPath = path.resolve(args.vault);
  const kind = inferSourceKind(args.source, args.kind);
  const title = resolveTitle(args, args.source, kind);

  let result;
  if (kind === "image" || kind === "asset") {
    result = await importImageSource({
      vaultPath,
      kind,
      source: args.source,
      title,
    });
  } else {
    result = await importStructuredSource({
      vaultPath,
      kind,
      source: args.source,
      title,
      bodyFile: args.bodyFile,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        vaultPath,
        kind,
        title,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
