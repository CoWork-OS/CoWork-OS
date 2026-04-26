import fs from "fs/promises";
import path from "path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const dirFlagIndex = args.indexOf("--dir");
const releaseDir =
  dirFlagIndex >= 0 && args[dirFlagIndex + 1]
    ? path.resolve(args[dirFlagIndex + 1])
    : path.resolve(process.cwd(), "release");

function parseMetadata(content) {
  const files = [];
  let current = null;
  let primaryPath = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const pathMatch = /^path:\s*(.+)$/.exec(line);
    if (pathMatch) {
      primaryPath = path.basename(pathMatch[1].trim());
      continue;
    }

    const urlMatch = /^-\s+url:\s*(.+)$/.exec(line.trim());
    if (urlMatch) {
      current = { name: path.basename(urlMatch[1].trim()), size: null };
      files.push(current);
      continue;
    }

    const sizeMatch = /^size:\s*(\d+)$/.exec(line.trim());
    if (sizeMatch && current) {
      current.size = Number(sizeMatch[1]);
    }
  }

  const deduped = new Map();
  for (const file of files) {
    deduped.set(file.name, file);
  }
  if (primaryPath && !deduped.has(primaryPath)) {
    deduped.set(primaryPath, { name: primaryPath, size: null });
  }
  return [...deduped.values()];
}

async function readMetadataEntries(metadataFile) {
  const content = await fs.readFile(metadataFile, "utf8");
  return parseMetadata(content);
}

async function listReleaseFiles() {
  const names = await fs.readdir(releaseDir);
  const stats = await Promise.all(
    names.map(async (name) => {
      const fullPath = path.join(releaseDir, name);
      const stat = await fs.stat(fullPath);
      return stat.isFile() ? { name, fullPath, size: stat.size } : null;
    }),
  );
  return stats.filter(Boolean);
}

async function renameIfNeeded(fromName, toName) {
  if (fromName === toName) return false;
  const fromPath = path.join(releaseDir, fromName);
  const toPath = path.join(releaseDir, toName);
  await fs.rename(fromPath, toPath);
  return true;
}

async function alignEntry(entry, allFiles) {
  const desiredName = entry.name;
  const existing = allFiles.find((file) => file.name === desiredName);
  if (existing && (entry.size == null || existing.size === entry.size)) {
    return;
  }

  const desiredExt = path.extname(desiredName);
  const candidates = allFiles.filter((file) => {
    if (file.name === desiredName) return false;
    if (file.name.endsWith(".blockmap")) return false;
    if (path.extname(file.name) !== desiredExt) return false;
    if (entry.size != null && file.size !== entry.size) return false;
    return true;
  });

  if (candidates.length !== 1) {
    throw new Error(
      `Could not resolve artifact for ${desiredName}. Candidates: ${
        candidates.map((candidate) => candidate.name).join(", ") || "none"
      }`,
    );
  }

  const [source] = candidates;
  if (checkOnly) {
    throw new Error(
      `Artifact ${desiredName} is missing. Matching packaged file is ${source.name}.`,
    );
  }

  await renameIfNeeded(source.name, desiredName);

  const blockmapSource = `${source.name}.blockmap`;
  const blockmapTarget = `${desiredName}.blockmap`;
  if (allFiles.some((file) => file.name === blockmapSource)) {
    await renameIfNeeded(blockmapSource, blockmapTarget);
  }
}

async function main() {
  const metadataFiles = ["latest.yml", "latest-mac.yml"];
  const existingMetadataFiles = [];

  for (const metadataName of metadataFiles) {
    const metadataPath = path.join(releaseDir, metadataName);
    try {
      await fs.access(metadataPath);
      existingMetadataFiles.push(metadataPath);
    } catch {
      // Ignore metadata files that are not present for this platform.
    }
  }

  if (existingMetadataFiles.length === 0) {
    console.log("[release-artifacts] No updater metadata files found. Skipping.");
    return;
  }

  for (const metadataPath of existingMetadataFiles) {
    const entries = await readMetadataEntries(metadataPath);
    let files = await listReleaseFiles();
    for (const entry of entries) {
      await alignEntry(entry, files);
      files = await listReleaseFiles();
    }
  }

  const finalFiles = await listReleaseFiles();
  for (const metadataPath of existingMetadataFiles) {
    const entries = await readMetadataEntries(metadataPath);
    for (const entry of entries) {
      if (!finalFiles.some((file) => file.name === entry.name)) {
        throw new Error(`Artifact ${entry.name} is still missing after alignment.`);
      }
    }
  }

  console.log(
    `[release-artifacts] ${checkOnly ? "Validated" : "Aligned"} updater metadata filenames in ${releaseDir}.`,
  );
}

main().catch((error) => {
  console.error(`[release-artifacts] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
