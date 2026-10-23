#!/usr/bin/env node
/**
 * Bundled skill lineage index.
 *
 * Records a content digest for every version of each bundled skill manifest that CoWork has
 * shipped (resources/skills/<id>.json) or published to the SkillHub registry mirror
 * (registry/skills/<id>.json). CustomSkillLoader uses it to recognise a managed skill that
 * is an unmodified copy of an earlier bundled version, so a bundled update is not silently
 * hidden by that stale copy (see `isStaleBundledSnapshot` in custom-skill-loader.ts).
 *
 *   node scripts/qa/build-bundled-skill-lineage.mjs          rebuild from git history
 *   node scripts/qa/build-bundled-skill-lineage.mjs --check  fail if a current manifest is missing
 *
 * Rebuilding only adds digests: entries already in the index are kept, so a shallow clone
 * never drops versions it cannot see. The check needs no history: it asks only that every
 * current manifest is recorded, which is what keeps each released version in the index.
 *
 * The digest must match `computeSkillManifestDigest` in src/electron/agent/skill-lineage.ts.
 */
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "src/electron/agent/bundled-skill-lineage.json");
const SOURCE_DIRS = ["resources/skills", "registry/skills"];
const BUNDLED_DIR = path.join(ROOT, "resources/skills");
const IGNORED_FIELDS = new Set(["filePath", "source", "enabled"]);
const DIGEST_LENGTH = 16;

function canonicalize(value, depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (depth === 0 && IGNORED_FIELDS.has(key)) continue;
      if (value[key] === undefined) continue;
      output[key] = canonicalize(value[key], depth + 1);
    }
    return output;
  }
  return value;
}

function digestManifest(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

function parseManifest(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isSkillManifestName(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".json") && !lower.endsWith(".security.json") && lower !== "build-mode.json"
  );
}

function currentBundledIds() {
  return new Set(
    fs
      .readdirSync(BUNDLED_DIR)
      .filter(isSkillManifestName)
      .map((fileName) => path.basename(fileName, ".json")),
  );
}

function currentManifests(ids) {
  const manifests = [];
  for (const dir of SOURCE_DIRS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const fileName of fs.readdirSync(absDir).filter(isSkillManifestName)) {
      const id = path.basename(fileName, ".json");
      if (!ids.has(id)) continue;
      const manifest = parseManifest(fs.readFileSync(path.join(absDir, fileName), "utf-8"));
      if (manifest) manifests.push({ id, file: `${dir}/${fileName}`, manifest });
    }
  }
  return manifests;
}

function readIndex() {
  if (!fs.existsSync(INDEX_PATH)) return { version: 1, skills: {} };
  const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  return { version: 1, skills: parsed.skills || {} };
}

function git(args, input) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Every historical blob of <dir>/<id>.json, as { id, blob }. */
function historicalBlobs(ids) {
  const raw = git(["log", "--raw", "--no-abbrev", "--format=", "--", ...SOURCE_DIRS]);
  const blobs = new Map();
  for (const line of raw.split("\n")) {
    // :100644 100644 <old> <new> M\tresources/skills/foo.json
    const match = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w+\t(.+)$/);
    if (!match) continue;
    const [, blob, filePath] = match;
    if (/^0+$/.test(blob)) continue;
    const dir = path.posix.dirname(filePath);
    const fileName = path.posix.basename(filePath);
    if (!SOURCE_DIRS.includes(dir) || !isSkillManifestName(fileName)) continue;
    const id = path.posix.basename(fileName, ".json");
    if (ids.has(id)) blobs.set(blob, id);
  }
  return blobs;
}

function readBlobs(blobShas) {
  if (blobShas.length === 0) return new Map();
  const output = spawnSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: `${blobShas.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (output.status !== 0) throw new Error(`git cat-file failed: ${output.stderr}`);
  const buffer = output.stdout;
  const contents = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf(10, offset);
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const [sha, type, sizeText] = header.split(" ");
    if (type === "missing") {
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(sizeText);
    contents.set(sha, buffer.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return contents;
}

function addDigest(index, id, digest) {
  const list = index.skills[id] || (index.skills[id] = []);
  if (!list.includes(digest)) list.push(digest);
}

/** Writes the index in the repo's formatter style (oxfmt, 100 columns). */
function writeIndex(index) {
  const ids = Object.keys(index.skills).sort();
  const lines = ids.map((id, position) => {
    const digests = [...index.skills[id]].sort().map((digest) => JSON.stringify(digest));
    const comma = position < ids.length - 1 ? "," : "";
    const inline = `    ${JSON.stringify(id)}: [${digests.join(", ")}]${comma}`;
    if (inline.length <= 100) return inline;
    return [
      `    ${JSON.stringify(id)}: [`,
      digests.map((digest) => `      ${digest}`).join(",\n"),
      `    ]${comma}`,
    ].join("\n");
  });
  fs.writeFileSync(INDEX_PATH, `{\n  "version": 1,\n  "skills": {\n${lines.join("\n")}\n  }\n}\n`);
}

const ids = currentBundledIds();
const index = readIndex();

if (process.argv.includes("--check")) {
  const missing = currentManifests(ids).filter(
    ({ id, manifest }) => !(index.skills[id] || []).includes(digestManifest(manifest)),
  );
  if (missing.length > 0) {
    console.error(
      `[skill-lineage] ${missing.length} current skill manifest(s) are not in ${path.relative(ROOT, INDEX_PATH)}:`,
    );
    for (const entry of missing.slice(0, 20)) console.error(`  - ${entry.file}`);
    console.error("Run: node scripts/qa/build-bundled-skill-lineage.mjs");
    process.exit(1);
  }
  console.log(`[skill-lineage] ok (${Object.keys(index.skills).length} bundled skills indexed)`);
  process.exit(0);
}

let historical = 0;
const blobs = historicalBlobs(ids);
for (const [sha, text] of readBlobs([...blobs.keys()])) {
  const manifest = parseManifest(text);
  if (!manifest) continue;
  addDigest(index, blobs.get(sha), digestManifest(manifest));
  historical += 1;
}
for (const { id, manifest } of currentManifests(ids)) {
  addDigest(index, id, digestManifest(manifest));
}
writeIndex(index);
console.log(
  `[skill-lineage] wrote ${path.relative(ROOT, INDEX_PATH)} (${Object.keys(index.skills).length} skills, ${historical} historical manifests read)`,
);
