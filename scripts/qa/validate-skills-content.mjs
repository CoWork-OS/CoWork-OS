#!/usr/bin/env node
import path from "path";
import { validateSkillsContent, printValidationSummary } from "./skills-content-lib.mjs";

function parseArgs(argv) {
  const args = {
    skillsDir: path.join(process.cwd(), "resources", "skills"),
    strictWarnings: process.env.SKILLS_VALIDATE_STRICT_WARNINGS === "1",
    enforcePaths: process.env.SKILLS_VALIDATE_ENFORCE_PATHS === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skills-dir") {
      args.skillsDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--strict-warnings") {
      args.strictWarnings = true;
      continue;
    }
    if (arg === "--enforce-paths") {
      args.enforcePaths = true;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = validateSkillsContent({ skillsDir: args.skillsDir, enforcePaths: args.enforcePaths });
printValidationSummary(result);

if (result.errors.length > 0) {
  process.exit(1);
}
if (args.strictWarnings && result.warnings.length > 0) {
  process.exit(1);
}
process.exit(0);
