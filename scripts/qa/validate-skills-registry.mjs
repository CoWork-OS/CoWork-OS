#!/usr/bin/env node
// Flags SkillHub registry entries whose description has drifted from the bundled
// skill of the same id. registry/ is a copy of resources/skills/ made by
// scripts/generate-skill-catalog.ts, which nothing runs automatically, so an
// edited bundled skill keeps advertising its old description in the registry.
import fs from "fs";
import path from "path";

const root = process.cwd();
const bundledDir = path.join(root, "resources", "skills");
const registryDir = path.join(root, "registry", "skills");
const catalogPath = path.join(root, "registry", "catalog.json");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const bundledDescription = (id) => {
  const filePath = path.join(bundledDir, `${id}.json`);
  return fs.existsSync(filePath) ? String(readJson(filePath).description || "") : null;
};

const errors = [];

for (const file of fs
  .readdirSync(registryDir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const entry = readJson(path.join(registryDir, file));
  if (!entry?.id) continue;
  const expected = bundledDescription(entry.id);
  if (expected !== null && String(entry.description || "") !== expected) {
    errors.push(
      `registry/skills/${file}: description differs from resources/skills/${entry.id}.json`,
    );
  }
}

for (const entry of readJson(catalogPath).skills || []) {
  const expected = bundledDescription(entry.id);
  if (expected !== null && String(entry.description || "") !== expected) {
    errors.push(
      `registry/catalog.json "${entry.id}": description differs from resources/skills/${entry.id}.json`,
    );
  }
}

if (errors.length > 0) {
  console.error("[skills-registry] registry entries drifted from bundled skills:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error(
    "Copy resources/skills/<id>.json to registry/skills/ and update the registry/catalog.json entry.",
  );
  process.exit(1);
}

console.log("[skills-registry] registry descriptions match bundled skills");
