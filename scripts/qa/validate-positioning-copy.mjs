import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const positioningFiles = [
  "README.md",
  "SECURITY.md",
  "SECURITY_GUIDE.md",
  "package.json",
  "docs/.vitepress/config.mts",
  "docs/index.md",
  "docs/getting-started.md",
  "docs/providers.md",
  "docs/what-you-own.md",
  "docs/migration.md",
  "docs/comparisons/index.md",
  "src/renderer/components/HomeDashboard.tsx",
  "src/renderer/components/UseCasesGallery.tsx",
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
  {
    pattern: /\bkeys? never leave\b/i,
    guidance: "describe credential storage and provider transmission",
  },
  { pattern: /\bstart with ChatGPT\b/i, guidance: "keep onboarding provider-neutral" },
  { pattern: /\bTell Codex\b/i, guidance: "use the CoWork OS product name" },
  { pattern: /\b36 LLM provider options\b/i, guidance: "avoid drift-prone fixed provider counts" },
  // Retired taglines: the motto "Rent the model. Own everything else." replaces them.
  {
    pattern: /\bopen desktop for getting work done with the AI you choose\b/i,
    guidance: "retired tagline; use the motto",
  },
  { pattern: /\breal work with AI, on your terms\b/i, guidance: "retired tagline; use the motto" },
  { pattern: /\bopen-source OS for AI agents\b/i, guidance: "retired tagline; use the motto" },
  {
    pattern: /\blocal-first personal agentic OS and everything app\b/i,
    guidance: "retired tagline; use the motto",
  },
  // Ownership claims that docs/what-you-own.md does not back.
  {
    pattern: /\bown your (?:AI|intelligence|models?)\b/i,
    guidance: "users rent the model; only what docs/what-you-own.md lists is owned",
  },
  {
    pattern: /\bnever phones? home\b/i,
    guidance: "the startup update check calls pulse.coworkosapp.com",
  },
  {
    pattern: /\bno (?:app )?telemetry\b/i,
    guidance: "CoWork Pulse is opt-in; say telemetry is off unless you opt in",
  },
  {
    pattern: /\bnothing (?:ever )?leaves your (?:machine|device|computer)\b/i,
    guidance: "prompts, files and memory text go to the model provider",
  },
  {
    pattern: /\btake everything with you\b/i,
    guidance: "there is no full export yet; see docs/what-you-own.md",
  },
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
