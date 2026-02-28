#!/usr/bin/env node
import fs from "fs";
import path from "path";

const SKILLS_DIR = path.join(process.cwd(), "resources", "skills");
const IGNORED = new Set(["build-mode.json"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function inferComplexity(length) {
  if (length <= 2000) return "low";
  if (length <= 5000) return "medium";
  return "high";
}

function compact(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function ensureExamples(skill) {
  const routing = (skill.metadata = skill.metadata || {}).routing || (skill.metadata.routing = {});
  const topic = compact(skill.name || skill.id || "this skill");
  const useWhen = compact(routing.useWhen || skill.description || "Use for in-domain execution tasks");
  const dontUseWhen = compact(routing.dontUseWhen || "Avoid this skill for out-of-domain requests");

  const positive = Array.isArray(routing.examples?.positive)
    ? routing.examples.positive.filter(isNonEmptyString).map((item) => compact(item))
    : [];
  const negative = Array.isArray(routing.examples?.negative)
    ? routing.examples.negative.filter(isNonEmptyString).map((item) => compact(item))
    : [];

  const positiveCandidates = [
    ...positive,
    `Use the ${skill.id} skill for this request.`,
    `Help me with ${topic.toLowerCase()}.`,
    useWhen,
    `${topic}: provide an actionable result.`,
  ];

  const negativeCandidates = [
    ...negative,
    dontUseWhen,
    `Do not use ${skill.id} for unrelated requests.`,
    `This request is outside ${topic.toLowerCase()} scope.`,
    "This is conceptual discussion only; no tool workflow is needed.",
  ];

  const uniq = (items) => Array.from(new Set(items.filter(isNonEmptyString).map((i) => compact(i))));

  routing.examples = {
    positive: uniq(positiveCandidates).slice(0, 5),
    negative: uniq(negativeCandidates).slice(0, 5),
  };

  while (routing.examples.positive.length < 3) {
    routing.examples.positive.push(`Use ${skill.id} for in-scope execution.`);
  }
  while (routing.examples.negative.length < 3) {
    routing.examples.negative.push(`Do not use ${skill.id} for out-of-scope requests.`);
  }

  if (!isNonEmptyString(routing.outputs)) {
    routing.outputs = `Task-specific output produced by ${skill.id} with concrete, user-actionable details.`;
  }
  if (!isNonEmptyString(routing.successCriteria)) {
    routing.successCriteria = "Output is actionable, specific, and aligned with requested scope and constraints.";
  }
}

function normalizeSelectOptions(skill) {
  if (!Array.isArray(skill.parameters)) return;

  for (const param of skill.parameters) {
    if (param?.type !== "select") continue;
    if (!Array.isArray(param.options)) {
      param.options = [];
      continue;
    }

    param.options = param.options
      .map((option) => {
        if (typeof option === "string") return option;
        if (option && typeof option === "object" && typeof option.value === "string") {
          return option.value;
        }
        return null;
      })
      .filter((option) => typeof option === "string");
  }
}

function buildSkillMd(skill, promptLength, extracted) {
  const routing = skill.metadata?.routing || {};
  const lines = [];
  lines.push("---");
  lines.push(`name: ${skill.id}`);
  lines.push(`description: ${JSON.stringify(skill.description || "")}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${skill.name || skill.id}`);
  lines.push("");
  lines.push("## Purpose");
  lines.push("");
  lines.push(skill.description || "No description provided.");
  lines.push("");
  lines.push("## Routing");
  lines.push("");
  lines.push(`- Use when: ${routing.useWhen || "n/a"}`);
  lines.push(`- Do not use when: ${routing.dontUseWhen || "n/a"}`);
  lines.push(`- Outputs: ${routing.outputs || "n/a"}`);
  lines.push(`- Success criteria: ${routing.successCriteria || "n/a"}`);
  lines.push("");
  lines.push("## Trigger Examples");
  lines.push("");
  lines.push("### Positive");
  lines.push("");
  for (const example of routing.examples?.positive || []) {
    lines.push(`- ${example}`);
  }
  lines.push("");
  lines.push("### Negative");
  lines.push("");
  for (const example of routing.examples?.negative || []) {
    lines.push(`- ${example}`);
  }

  if (Array.isArray(skill.parameters) && skill.parameters.length > 0) {
    lines.push("");
    lines.push("## Parameters");
    lines.push("");
    lines.push("| Name | Type | Required | Description |");
    lines.push("|---|---|---|---|");
    for (const param of skill.parameters) {
      lines.push(
        `| ${param.name || ""} | ${param.type || ""} | ${param.required ? "Yes" : "No"} | ${compact(param.description || "")} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Runtime Prompt");
  lines.push("");
  lines.push(`- Current runtime prompt length: ${promptLength} characters.`);
  if (extracted) {
    lines.push("- Full detailed guidance: `references/full-guidance.md`.");
    lines.push("- Runtime prompt in JSON is intentionally concise and references this guide.");
  } else {
    lines.push("- Runtime prompt is defined directly in `../" + skill.id + ".json`. ");
  }

  return lines.join("\n") + "\n";
}

function buildConcisePrompt(skill, hasScripts) {
  const routing = skill.metadata?.routing || {};
  const lines = [];
  lines.push(`# ${skill.name || skill.id}`);
  lines.push("");
  lines.push("Use this skill only when the request is in scope:");
  lines.push(`- ${routing.useWhen || skill.description || "In-domain request"}`);
  lines.push("");
  lines.push("Do not use this skill when:");
  lines.push(`- ${routing.dontUseWhen || "Out-of-domain request"}`);
  lines.push("");
  lines.push("Execution workflow:");
  lines.push("1. Read `{baseDir}/SKILL.md` for routing boundaries and expected outputs.");
  lines.push("2. Read `{baseDir}/references/full-guidance.md` for detailed procedures/examples.");
  if (hasScripts) {
    lines.push("3. Execute skill-local scripts under `{baseDir}/scripts` when available.");
  }
  lines.push(
    `${hasScripts ? "4" : "3"}. Return outputs matching: ${routing.outputs || "task-specific, actionable results"}.`,
  );
  lines.push(
    `${hasScripts ? "5" : "4"}. Verify success criteria: ${routing.successCriteria || "output is actionable and in scope"}.`,
  );
  return lines.join("\n").trim();
}

function migrate() {
  const files = fs
    .readdirSync(SKILLS_DIR)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !IGNORED.has(name.toLowerCase()))
    .sort();

  let updated = 0;
  let extracted = 0;

  for (const file of files) {
    const filePath = path.join(SKILLS_DIR, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const skill = JSON.parse(raw);
    if (!isNonEmptyString(skill.id)) {
      // skip malformed skills for safety; validators will flag them
      continue;
    }

    const prompt = String(skill.prompt || "");
    const promptLength = prompt.length;

    skill.metadata = skill.metadata || {};
    skill.metadata.authoring = {
      complexity: inferComplexity(promptLength),
    };

    ensureExamples(skill);
    normalizeSelectOptions(skill);

    const skillDir = path.join(SKILLS_DIR, skill.id);
    fs.mkdirSync(skillDir, { recursive: true });

    const shouldExtract = promptLength > 5000;
    if (shouldExtract) {
      const refsDir = path.join(skillDir, "references");
      fs.mkdirSync(refsDir, { recursive: true });
      const refPath = path.join(refsDir, "full-guidance.md");
      fs.writeFileSync(refPath, prompt.trim() + "\n", "utf8");
      const hasScripts = fs.existsSync(path.join(skillDir, "scripts"));
      skill.prompt = buildConcisePrompt(skill, hasScripts);
      extracted += 1;
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMdPath, buildSkillMd(skill, promptLength, shouldExtract), "utf8");

    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2) + "\n", "utf8");
    updated += 1;
  }

  console.log(`[skills-migrate] Updated ${updated} skills`);
  console.log(`[skills-migrate] Extracted full guidance for ${extracted} long prompts (>5000 chars)`);
}

migrate();
