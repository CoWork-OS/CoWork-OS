#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { validateSkillsContent } from "./skills-content-lib.mjs";

function parseArgs(argv) {
  const args = {
    skillsDir: path.join(process.cwd(), "resources", "skills"),
    outDir: path.join(process.cwd(), "tmp", "qa"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skills-dir") {
      args.skillsDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--out-dir") {
      args.outDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function toRisk(record) {
  if (record.errors.length > 0) return "high";
  if (record.warnings.length > 0) return "medium";
  return "low";
}

function buildMarkdown(report) {
  const lines = [];
  lines.push("# Skills Audit Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Skills checked: ${report.summary.checked}`);
  lines.push(`- Errors: ${report.summary.errors}`);
  lines.push(`- Warnings: ${report.summary.warnings}`);
  lines.push(`- High risk: ${report.summary.risk.high}`);
  lines.push(`- Medium risk: ${report.summary.risk.medium}`);
  lines.push(`- Low risk: ${report.summary.risk.low}`);
  lines.push("");
  lines.push("## Skill Scorecard");
  lines.push("");
  lines.push("| Skill | Prompt Length | Complexity | Budget | Errors | Warnings | Risk |");
  lines.push("|---|---:|---|---:|---:|---:|---|");

  for (const skill of report.skills.sort((a, b) => {
    const riskOrder = { high: 0, medium: 1, low: 2 };
    return riskOrder[a.risk] - riskOrder[b.risk] || b.errors.length - a.errors.length;
  })) {
    lines.push(
      `| ${skill.skillId} | ${skill.metrics?.promptLength ?? "-"} | ${skill.metrics?.complexity ?? "-"} | ${skill.metrics?.budget ?? "-"} | ${skill.errors.length} | ${skill.warnings.length} | ${skill.risk} |`,
    );
  }

  lines.push("");
  lines.push("## Findings");
  lines.push("");

  const topIssues = report.skills
    .flatMap((skill) => [
      ...skill.errors.map((issue) => ({ level: "ERROR", skill: skill.skillId, issue })),
      ...skill.warnings.map((issue) => ({ level: "WARN", skill: skill.skillId, issue })),
    ])
    .slice(0, 500);

  if (topIssues.length === 0) {
    lines.push("- No findings.");
  } else {
    for (const item of topIssues) {
      lines.push(`- ${item.level}: ${item.skill}: ${item.issue}`);
    }
  }

  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const result = validateSkillsContent({ skillsDir: args.skillsDir });

const skills = result.records.map((record) => ({
  ...record,
  risk: toRisk(record),
}));

const summary = {
  checked: result.checked,
  errors: result.errors.length,
  warnings: result.warnings.length,
  risk: {
    high: skills.filter((skill) => skill.risk === "high").length,
    medium: skills.filter((skill) => skill.risk === "medium").length,
    low: skills.filter((skill) => skill.risk === "low").length,
  },
};

const report = {
  generatedAt: new Date().toISOString(),
  skillsDir: args.skillsDir,
  summary,
  skills,
};

fs.mkdirSync(args.outDir, { recursive: true });

const jsonPath = path.join(args.outDir, "skills-audit-report.json");
const mdPath = path.join(args.outDir, "skills-audit-report.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(mdPath, buildMarkdown(report), "utf8");

console.log(`[skills-audit] Wrote JSON report: ${jsonPath}`);
console.log(`[skills-audit] Wrote Markdown report: ${mdPath}`);
console.log(
  `[skills-audit] Summary: checked=${summary.checked}, errors=${summary.errors}, warnings=${summary.warnings}`,
);
