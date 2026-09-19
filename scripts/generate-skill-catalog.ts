#!/usr/bin/env ts-node
/**
 * Generate SkillHub Catalog
 *
 * Reads all bundled skills from resources/skills/ and generates a
 * registry catalog at registry/catalog.json for the GitHub-based
 * SkillHub community registry.
 *
 * Usage: npx ts-node scripts/generate-skill-catalog.ts
 */

import * as fs from "fs";
import * as path from "path";

interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  rating?: number;
  tags?: string[];
  icon?: string;
  category?: string;
  updatedAt?: string;
  homepage?: string;
}

interface RegistryCatalog {
  version: number;
  generatedAt: string;
  skills: SkillRegistryEntry[];
}

const SKILLS_DIR = path.join(__dirname, "..", "resources", "skills");
const REGISTRY_DIR = path.join(__dirname, "..", "registry");
const CATALOG_PATH = path.join(REGISTRY_DIR, "catalog.json");
const SKILLS_OUTPUT_DIR = path.join(REGISTRY_DIR, "skills");

function main(): void {
  // Ensure registry directories exist
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.mkdirSync(SKILLS_OUTPUT_DIR, { recursive: true });

  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".json"));
  const entries: SkillRegistryEntry[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
      const skill = JSON.parse(raw);

      const entry: SkillRegistryEntry = {
        id: skill.id || path.basename(file, ".json"),
        name: skill.name || skill.id || path.basename(file, ".json"),
        description: skill.description || "",
        version: skill.metadata?.version || "1.0.0",
        author: skill.metadata?.author || "CoWork OS",
        tags: skill.metadata?.tags || (skill.category ? [skill.category] : []),
        icon: skill.icon || undefined,
        category: skill.category || "general",
        updatedAt: new Date().toISOString().split("T")[0],
        homepage: `https://github.com/CoWork-OS/CoWork-OS/blob/main/resources/skills/${file}`,
      };

      entries.push(entry);

      // Copy skill file to registry/skills/
      fs.copyFileSync(path.join(SKILLS_DIR, file), path.join(SKILLS_OUTPUT_DIR, file));
    } catch (err) {
      console.error(`Failed to process ${file}:`, err);
    }
  }

  // Sort by name
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const catalog: RegistryCatalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    skills: entries,
  };

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");

  console.log(`Generated catalog with ${entries.length} skills at ${CATALOG_PATH}`);
  console.log(`Copied ${entries.length} skill files to ${SKILLS_OUTPUT_DIR}`);
}

main();
