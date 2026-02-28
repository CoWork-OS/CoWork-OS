#!/usr/bin/env node
import fs from "fs";
import path from "path";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalize(value);
  if (!normalized) return [];
  return normalized.split(" ");
}

function overlapScore(prompt, signal) {
  const promptTokens = tokenize(prompt);
  const signalTokens = tokenize(signal);
  if (promptTokens.length === 0 || signalTokens.length === 0) {
    return 0;
  }

  const promptSet = new Set(promptTokens);
  const signalSet = new Set(signalTokens);
  let overlap = 0;
  for (const token of promptSet) {
    if (signalSet.has(token)) overlap += 1;
  }

  if (overlap === 0) return 0;
  return overlap / Math.sqrt(promptSet.size * signalSet.size);
}

function parseArgs(argv) {
  const args = {
    skillsDir: path.join(process.cwd(), "resources", "skills"),
    datasetPath: path.join(process.cwd(), "resources", "skills", "_evals", "routing-cases.jsonl"),
    strict: false,
    liveModel: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skills-dir") {
      args.skillsDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--dataset") {
      args.datasetPath = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--strict") {
      args.strict = true;
      continue;
    }
    if (arg === "--live-model") {
      args.liveModel = true;
    }
  }

  return args;
}

function loadSkills(skillsDir) {
  const files = fs
    .readdirSync(skillsDir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => name.toLowerCase() !== "build-mode.json")
    .sort();

  return files
    .map((file) => {
      const filePath = path.join(skillsDir, file);
      try {
        const skill = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const signal = [
          skill.id,
          skill.name,
          skill.description,
          skill?.metadata?.routing?.useWhen,
          skill?.metadata?.routing?.dontUseWhen,
          ...(skill?.metadata?.routing?.examples?.positive || []),
          ...(skill?.metadata?.routing?.examples?.negative || []),
        ]
          .filter(Boolean)
          .join(" ");

        return { id: skill.id || path.basename(file, ".json"), signal, skill };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rankSkills(prompt, skills) {
  return skills
    .map((skill) => ({ id: skill.id, score: overlapScore(prompt, skill.signal) }))
    .sort((a, b) => b.score - a.score);
}

function evaluateExamples(skills) {
  let expectedTotal = 0;
  let expectedHits = 0;
  let forbiddenTotal = 0;
  let forbiddenMisfires = 0;

  for (const item of skills) {
    const examples = item.skill?.metadata?.routing?.examples;
    const positives = Array.isArray(examples?.positive) ? examples.positive : [];
    const negatives = Array.isArray(examples?.negative) ? examples.negative : [];

    for (const prompt of positives) {
      expectedTotal += 1;
      const ranked = rankSkills(prompt, skills);
      if (ranked[0]?.id === item.id) {
        expectedHits += 1;
      }
    }

    for (const prompt of negatives) {
      forbiddenTotal += 1;
      const ranked = rankSkills(prompt, skills);
      if (ranked[0]?.id === item.id) {
        forbiddenMisfires += 1;
      }
    }
  }

  return { expectedTotal, expectedHits, forbiddenTotal, forbiddenMisfires };
}

function evaluateDataset(skills, datasetPath) {
  if (!fs.existsSync(datasetPath)) {
    return { expectedTotal: 0, expectedHits: 0, forbiddenTotal: 0, forbiddenMisfires: 0 };
  }

  const lines = fs
    .readFileSync(datasetPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let expectedTotal = 0;
  let expectedHits = 0;
  let forbiddenTotal = 0;
  let forbiddenMisfires = 0;

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const prompt = String(row.prompt || "");
      const expectedIds = Array.isArray(row.expectedSkillIds) ? row.expectedSkillIds : [];
      const forbiddenIds = Array.isArray(row.forbiddenSkillIds) ? row.forbiddenSkillIds : [];
      if (!prompt) continue;

      const ranked = rankSkills(prompt, skills);
      const top3 = ranked.slice(0, 3).map((entry) => entry.id);
      const top1 = ranked[0]?.id;

      if (expectedIds.length > 0) {
        expectedTotal += 1;
        if (expectedIds.some((id) => top3.includes(id))) {
          expectedHits += 1;
        }
      }

      if (forbiddenIds.length > 0) {
        forbiddenTotal += 1;
        if (forbiddenIds.includes(top1)) {
          forbiddenMisfires += 1;
        }
      }
    } catch {
      // skip invalid rows
    }
  }

  return { expectedTotal, expectedHits, forbiddenTotal, forbiddenMisfires };
}

const args = parseArgs(process.argv.slice(2));
const skills = loadSkills(args.skillsDir);

if (args.liveModel) {
  console.log(
    "[skills-eval-routing] --live-model requested. Running deterministic eval now (live model mode is intentionally non-blocking).",
  );
}

const examples = evaluateExamples(skills);
const dataset = evaluateDataset(skills, args.datasetPath);

const expectedTotal = examples.expectedTotal + dataset.expectedTotal;
const expectedHits = examples.expectedHits + dataset.expectedHits;
const forbiddenTotal = examples.forbiddenTotal + dataset.forbiddenTotal;
const forbiddenMisfires = examples.forbiddenMisfires + dataset.forbiddenMisfires;

const expectedHitRate = expectedTotal === 0 ? 1 : expectedHits / expectedTotal;
const forbiddenMisfireRate = forbiddenTotal === 0 ? 0 : forbiddenMisfires / forbiddenTotal;

console.log(`[skills-eval-routing] Skills: ${skills.length}`);
console.log(`[skills-eval-routing] Expected hit rate: ${(expectedHitRate * 100).toFixed(2)}% (${expectedHits}/${expectedTotal})`);
console.log(
  `[skills-eval-routing] Forbidden misfire rate: ${(forbiddenMisfireRate * 100).toFixed(2)}% (${forbiddenMisfires}/${forbiddenTotal})`,
);

if (args.strict) {
  const expectedOk = expectedHitRate >= 0.95;
  const forbiddenOk = forbiddenMisfireRate <= 0.02;
  if (!expectedOk || !forbiddenOk) {
    console.log("[skills-eval-routing] Strict threshold failure");
    process.exit(1);
  }
}

process.exit(0);
