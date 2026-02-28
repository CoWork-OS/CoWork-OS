#!/usr/bin/env node
import fs from "fs";
import path from "path";

export const COMPLEXITY_BUDGETS = {
  low: 2000,
  medium: 5000,
  high: 8000,
};
const IGNORED_SKILL_METADATA_FILES = new Set(["build-mode.json"]);

const ALLOWED_SINGLE_PLACEHOLDERS = new Set(["baseDir", "artifactDir"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(" ");
}

function jaccardSimilarity(aText, bText) {
  const a = new Set(tokenize(aText));
  const b = new Set(tokenize(bText));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function inferComplexity(promptLength) {
  if (promptLength <= COMPLEXITY_BUDGETS.low) return "low";
  if (promptLength <= COMPLEXITY_BUDGETS.medium) return "medium";
  return "high";
}

export function resolveSkillBaseDirForValidation(skillPath, skillId, prompt = "") {
  const fileDir = path.dirname(skillPath);
  if (!isNonEmptyString(skillId)) {
    return fileDir;
  }
  const skillScopedDir = path.join(fileDir, skillId);
  try {
    if (fs.existsSync(skillScopedDir) && fs.statSync(skillScopedDir).isDirectory()) {
      const requiresScopedDir =
        prompt.includes("{baseDir}/SKILL.md") || prompt.includes("{baseDir}/references/");
      const scopedHasScripts = fs.existsSync(path.join(skillScopedDir, "scripts"));
      const referencedRelativePaths = Array.from(
        prompt.matchAll(/\{baseDir\}\/([A-Za-z0-9._\-/]+)/g),
        (match) => match[1],
      );
      const scopedHits = referencedRelativePaths.filter((relPath) =>
        fs.existsSync(path.join(skillScopedDir, relPath)),
      ).length;
      const fileDirHits = referencedRelativePaths.filter((relPath) =>
        fs.existsSync(path.join(fileDir, relPath)),
      ).length;
      if (requiresScopedDir || scopedHasScripts) {
        return skillScopedDir;
      }
      if (referencedRelativePaths.length > 0 && scopedHits > fileDirHits) {
        return skillScopedDir;
      }
    }
  } catch {
    // ignore and fall back
  }
  return fileDir;
}

export function validateSkillManifest(skillPath, skill, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isNonEmptyString(skill?.id)) {
    errors.push("Missing required field: id");
  }
  if (!isNonEmptyString(skill?.name)) {
    errors.push("Missing required field: name");
  }
  if (!isNonEmptyString(skill?.description)) {
    errors.push("Missing required field: description");
  }
  if (!isNonEmptyString(skill?.prompt)) {
    errors.push("Missing required field: prompt");
  }

  const prompt = String(skill?.prompt || "");
  const promptLength = prompt.length;

  const complexity = skill?.metadata?.authoring?.complexity;
  if (!["low", "medium", "high"].includes(complexity || "")) {
    warnings.push(
      `metadata.authoring.complexity is missing or invalid; inferred complexity would be \"${inferComplexity(promptLength)}\"`,
    );
  }
  const normalizedComplexity = ["low", "medium", "high"].includes(complexity || "")
    ? complexity
    : inferComplexity(promptLength);

  const budget = COMPLEXITY_BUDGETS[normalizedComplexity];
  if (promptLength > budget) {
    warnings.push(
      `Prompt length ${promptLength} exceeds ${normalizedComplexity} budget ${budget} characters`,
    );
  }

  const routing = skill?.metadata?.routing;
  if (!routing) {
    errors.push("metadata.routing is missing");
  } else {
    if (!isNonEmptyString(routing.useWhen)) {
      warnings.push("metadata.routing.useWhen is missing or empty");
    }
    if (!isNonEmptyString(routing.dontUseWhen)) {
      warnings.push("metadata.routing.dontUseWhen is missing or empty");
    }
    if (!isNonEmptyString(routing.outputs)) {
      warnings.push("metadata.routing.outputs is missing or empty");
    }
    if (!isNonEmptyString(routing.successCriteria)) {
      warnings.push("metadata.routing.successCriteria is missing or empty");
    }

    const examples = routing.examples;
    const positive = Array.isArray(examples?.positive) ? examples.positive : [];
    const negative = Array.isArray(examples?.negative) ? examples.negative : [];
    if (positive.length < 3) {
      warnings.push("metadata.routing.examples.positive should include at least 3 examples");
    }
    if (negative.length < 3) {
      warnings.push("metadata.routing.examples.negative should include at least 3 examples");
    }
    if (positive.some((item) => !isNonEmptyString(item))) {
      warnings.push("metadata.routing.examples.positive contains empty values");
    }
    if (negative.some((item) => !isNonEmptyString(item))) {
      warnings.push("metadata.routing.examples.negative contains empty values");
    }
  }

  const params = Array.isArray(skill?.parameters) ? skill.parameters : [];
  const paramNames = new Set(
    params
      .map((param) => (typeof param?.name === "string" ? param.name : ""))
      .filter((name) => name.trim().length > 0),
  );

  for (const param of params) {
    if (param?.type === "select") {
      const options = Array.isArray(param.options) ? param.options : [];
      const invalidOption = options.find((option) => typeof option !== "string");
      if (invalidOption !== undefined) {
        errors.push(
          `Parameter \"${param.name}\" has invalid select options; expected string[]`,
        );
      }
    }
  }

  const baseDir = resolveSkillBaseDirForValidation(skillPath, skill?.id, prompt);
  const enforcePaths = options.enforcePaths === true;
  const baseDirRefs = [...prompt.matchAll(/\{baseDir\}\/([A-Za-z0-9._\-/]+)/g)].map(
    (match) => match[1],
  );
  for (const relRef of baseDirRefs) {
    const target = path.resolve(baseDir, relRef);
    if (!fs.existsSync(target)) {
      const issue = `Prompt references missing path: {baseDir}/${relRef}`;
      if (enforcePaths) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  for (const match of prompt.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    const name = match[1];
    if (!paramNames.has(name)) {
      warnings.push(`Prompt references undeclared parameter placeholder: {{${name}}}`);
    }
  }

  for (const match of prompt.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    const token = match[1];
    const idx = match.index ?? 0;
    const full = match[0];
    const prev = prompt[idx - 1];
    const next = prompt[idx + full.length];
    if (prev === "{" || next === "}") {
      continue;
    }
    if (!ALLOWED_SINGLE_PLACEHOLDERS.has(token)) {
      warnings.push(`Prompt uses non-standard single placeholder: {${token}}`);
    }
  }

  return {
    errors,
    warnings,
    metrics: {
      promptLength,
      complexity: normalizedComplexity,
      budget,
    },
  };
}

export function collectSkills(skillsDir) {
  const files = fs
    .readdirSync(skillsDir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !IGNORED_SKILL_METADATA_FILES.has(name.toLowerCase()))
    .sort();

  return files.map((file) => {
    const filePath = path.join(skillsDir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    return { file, filePath, raw };
  });
}

export function validateSkillsContent({ skillsDir, enforcePaths = false }) {
  const records = [];
  const errors = [];
  const warnings = [];

  const skills = [];
  for (const item of collectSkills(skillsDir)) {
    try {
      const skill = JSON.parse(item.raw);
      const result = validateSkillManifest(item.filePath, skill, { enforcePaths });
      records.push({
        file: item.file,
        skillId: skill?.id || path.basename(item.file, ".json"),
        errors: result.errors,
        warnings: result.warnings,
        metrics: result.metrics,
      });
      skills.push({ file: item.file, skill });

      for (const issue of result.errors) {
        errors.push({ file: item.file, issue });
      }
      for (const issue of result.warnings) {
        warnings.push({ file: item.file, issue });
      }
    } catch (error) {
      const issue = `Invalid JSON: ${error.message}`;
      errors.push({ file: item.file, issue });
      records.push({
        file: item.file,
        skillId: path.basename(item.file, ".json"),
        errors: [issue],
        warnings: [],
        metrics: null,
      });
    }
  }

  for (let i = 0; i < skills.length; i += 1) {
    const a = skills[i];
    const useWhenA = a.skill?.metadata?.routing?.useWhen;
    if (!isNonEmptyString(useWhenA)) continue;

    for (let j = i + 1; j < skills.length; j += 1) {
      const b = skills[j];
      const useWhenB = b.skill?.metadata?.routing?.useWhen;
      if (!isNonEmptyString(useWhenB)) continue;
      const similarity = jaccardSimilarity(useWhenA, useWhenB);
      if (similarity >= 0.85) {
        warnings.push({
          file: a.file,
          issue: `routing.useWhen is near-identical to ${b.file} (similarity ${similarity.toFixed(2)})`,
        });
      }
    }
  }

  return {
    skillsDir,
    checked: records.length,
    errors,
    warnings,
    records,
  };
}

export function printValidationSummary(result) {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("[skills-content] OK: 0 errors, 0 warnings");
    return;
  }

  console.log(`[skills-content] Checked ${result.checked} skills`);
  console.log(`[skills-content] Errors: ${result.errors.length}`);
  for (const item of result.errors) {
    console.log(`- ERROR: ${item.file}: ${item.issue}`);
  }
  console.log(`[skills-content] Warnings: ${result.warnings.length}`);
  for (const item of result.warnings) {
    console.log(`- WARN: ${item.file}: ${item.issue}`);
  }
}
