#!/usr/bin/env node
import { spawnSync } from "child_process";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function getBranchName() {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "unknown";
  return String(result.stdout || "").trim() || "unknown";
}

const branch = getBranchName();
const phase = Number(process.env.SKILLS_CHECK_PHASE || "1");
const bypass = process.env.SKILLS_CHECK_BYPASS === "1";

if (bypass && /^hotfix\//.test(branch)) {
  console.log(`[skills-check] bypass enabled for hotfix branch: ${branch}`);
  process.exit(0);
}

console.log(`[skills-check] phase=${phase} branch=${branch}`);
run("node", ["scripts/qa/validate-skills-routing.mjs"]);
run("node", [
  "scripts/qa/validate-skills-content.mjs",
  ...(phase >= 2 ? ["--enforce-paths"] : []),
  ...(phase >= 3 ? ["--strict-warnings"] : []),
]);
run("node", ["scripts/qa/skills-audit-report.mjs"]);
run("node", [
  "scripts/qa/eval-skills-routing.mjs",
  ...(phase >= 3 ? ["--strict"] : []),
]);

console.log("[skills-check] complete");
