import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const positioningFiles = [
  "README.md",
  "package.json",
  "docs/index.md",
  "docs/providers.md",
  "docs/migration.md",
  "docs/comparisons/index.md",
  "src/renderer/components/HomeDashboard.tsx",
  "src/renderer/components/IdeasPanel.tsx",
  "src/renderer/components/MainContent/MainContent.tsx",
  "src/renderer/components/MainContent/ModelDropdown.tsx",
  "src/renderer/components/MainContent/StructuredInputPromptCard.tsx",
  "src/renderer/components/Onboarding/Onboarding.tsx",
  "src/renderer/components/Settings.tsx",
  "src/renderer/components/UpdateSettings.tsx",
  "src/renderer/hooks/useOnboardingFlow.ts",
  "src/shared/first-run-readiness.ts",
];

const forbiddenCopy = [
  { pattern: /\bany subscription\b/i, guidance: "name supported account routes and eligibility" },
  { pattern: /\bany LLM\b/i, guidance: "say supported model sources or routes" },
  { pattern: /\bevery model\b/i, guidance: "avoid universal model compatibility claims" },
  { pattern: /\bfully (?:local|offline|private)\b/i, guidance: "state the exact local boundary" },
  { pattern: /\bkeys? never leave\b/i, guidance: "describe credential storage and provider transmission" },
  { pattern: /\bstart with ChatGPT\b/i, guidance: "keep onboarding provider-neutral" },
  { pattern: /\bTell Codex\b/i, guidance: "use the CoWork OS product name" },
  { pattern: /\b36 LLM provider options\b/i, guidance: "avoid drift-prone fixed provider counts" },
];

const findings = [];
for (const relativePath of positioningFiles) {
  const content = await readFile(path.join(repoRoot, relativePath), "utf8");
  for (const rule of forbiddenCopy) {
    const match = content.match(rule.pattern);
    if (!match || match.index === undefined) continue;
    const line = content.slice(0, match.index).split("\n").length;
    findings.push(`${relativePath}:${line} ${JSON.stringify(match[0])} — ${rule.guidance}`);
  }
}

if (findings.length > 0) {
  console.error("Positioning copy validation failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Positioning copy validation passed (${positioningFiles.length} files).`);
}

