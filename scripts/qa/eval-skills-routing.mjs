#!/usr/bin/env node
import fs from "fs";
import path from "path";

import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isModelInvocableSkill,
  matchesExplicitSkillInvocationPhrase,
  normalizeSkillInvocationText,
  sanitizeRoutingQuery,
  matchesSkillRoutingQuery,
  rankModelInvocableSkillsForQuery,
  selectSkillPlanningHints,
} from "../../src/shared/skill-routing/index.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLED_SKILLS_DIR = path.join(PROJECT_ROOT, "resources", "skills");
const BUNDLED_DATASET = path.join(BUNDLED_SKILLS_DIR, "_evals", "routing-cases.jsonl");
const BUNDLED_CONTRACTS = path.join(BUNDLED_SKILLS_DIR, "_evals", "routing-contracts.json");
const BUNDLED_HINT_CASES = path.join(BUNDLED_SKILLS_DIR, "_evals", "hint-cases.jsonl");

function parseArgs(argv) {
  const args = {
    skillsDir: path.join(process.cwd(), "resources", "skills"),
    datasetPath: path.join(process.cwd(), "resources", "skills", "_evals", "routing-cases.jsonl"),
    strict: false,
    liveModel: false,
    reportPath: null,
    contractsPath: null,
    hintCasesPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--skills-dir", "--dataset", "--report", "--contracts", "--hint-cases"].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a path`);
      const key = {
        "--skills-dir": "skillsDir",
        "--dataset": "datasetPath",
        "--report": "reportPath",
        "--contracts": "contractsPath",
        "--hint-cases": "hintCasesPath",
      }[arg];
      args[key] = path.resolve(argv[++i]);
      continue;
    }
    if (arg === "--strict") {
      args.strict = true;
      continue;
    }
    if (arg === "--live-model") {
      args.liveModel = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return args;
}

export function loadSkills(skillsDir) {
  const files = fs
    .readdirSync(skillsDir)
    .filter((name) => name.endsWith(".json"))
    .filter(
      (name) =>
        name.toLowerCase() !== "build-mode.json" && !name.toLowerCase().endsWith(".security.json"),
    )
    .sort();

  return files
    .map((file) => {
      const filePath = path.join(skillsDir, file);
      try {
        const skill = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const id = skill.id || path.basename(file, ".json");
        return { id, skill: { ...skill, id } };
      } catch (error) {
        throw new Error(`Invalid routing skill: ${filePath}`, { cause: error });
      }
    })
    .filter(Boolean);
}

export function rankSkills(prompt, skills, options = {}) {
  return rankModelInvocableSkillsForQuery(
    skills.map((item) => item.skill),
    prompt,
    options,
  ).map(({ skill, score }) => ({ id: skill.id, score }));
}

function loadDataset(datasetPath) {
  if (!fs.existsSync(datasetPath)) throw new Error(`Routing dataset not found: ${datasetPath}`);
  return fs
    .readFileSync(datasetPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const row = JSON.parse(line);
        const idsValid = (ids) =>
          ids === undefined ||
          (Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.trim()));
        if (
          typeof row.prompt !== "string" ||
          !row.prompt.trim() ||
          !idsValid(row.expectedSkillIds) ||
          !idsValid(row.forbiddenSkillIds) ||
          (!row.expectedSkillIds?.length && !row.forbiddenSkillIds?.length)
        )
          throw new Error("A routing case requires a prompt and expected or forbidden skill IDs");
        return row;
      } catch (error) {
        throw new Error(`Invalid routing case at ${datasetPath}:${index + 1}`, { cause: error });
      }
    });
}

function contractKey({ source, skillId, prompt }) {
  return JSON.stringify([source, skillId, prompt]);
}

function validateContracts(contracts, corpus) {
  if (!contracts || contracts.version !== 1 || !contracts.corpus || !Array.isArray(contracts.cases))
    throw new Error("Invalid routing contracts: expected version 1, corpus and cases");
  for (const [key, observed] of Object.entries(corpus)) {
    const expected = contracts.corpus[key];
    if (!Number.isInteger(expected) || expected < 0)
      throw new Error(`Invalid routing contracts: corpus.${key} must be a nonnegative integer`);
    if (expected !== observed)
      throw new Error(
        `Routing contract corpus drift: ${key} expected ${expected}, received ${observed}`,
      );
  }
  for (const kind of ["manual_only", "guideline", "explicit_only", "installed_pack"]) {
    const expected = contracts.corpus.contractsByKind?.[kind];
    const observed = contracts.cases.filter((entry) => entry?.kind === kind).length;
    if (!Number.isInteger(expected) || expected < 0)
      throw new Error(`Invalid routing contracts: corpus.contractsByKind.${kind} is required`);
    if (expected !== observed)
      throw new Error(
        `Routing contract coverage drift: ${kind} expected ${expected}, received ${observed}`,
      );
  }
  const byKey = new Map();
  for (const entry of contracts.cases) {
    if (
      !entry ||
      !["positive_example", "dataset_expected"].includes(entry.source) ||
      typeof entry.skillId !== "string" ||
      !entry.skillId.trim() ||
      typeof entry.prompt !== "string" ||
      !entry.prompt.trim() ||
      typeof entry.evidence !== "string" ||
      !entry.evidence.trim() ||
      !["manual_only", "guideline", "explicit_only", "installed_pack"].includes(entry.kind)
    )
      throw new Error(
        "Invalid routing contract case: source, skillId, prompt, kind and evidence required",
      );
    if (entry.kind === "installed_pack") {
      if (
        !entry.packPath ||
        typeof entry.packPath !== "string" ||
        !entry.packSkillId ||
        typeof entry.packSkillId !== "string"
      )
        throw new Error(`Invalid installed-pack routing contract: ${entry.skillId}`);
    } else {
      const required = { enabled: true };
      if (entry.kind === "manual_only")
        Object.assign(required, { disableModelInvocation: true, userInvocable: true });
      if (entry.kind === "guideline") required.type = "guideline";
      if (
        !entry.policy ||
        Object.entries(required).some(([key, value]) => entry.policy[key] !== value)
      )
        throw new Error(
          `Missing independent policy snapshot for routing contract: ${entry.skillId}`,
        );
      if (
        Object.entries(entry.policy).some(
          ([key, value]) =>
            !["enabled", "type", "disableModelInvocation", "userInvocable"].includes(key) ||
            (key === "type" ? value !== "guideline" : value !== true),
        )
      )
        throw new Error(`Invalid policy snapshot for routing contract: ${entry.skillId}`);
    }
    const key = contractKey(entry);
    if (byKey.has(key))
      throw new Error(`Duplicate routing contract: ${entry.skillId} ${entry.prompt}`);
    byKey.set(key, entry);
  }
  return byKey;
}

function loadPackSkills(entry, skills) {
  const packPath = path.resolve(PROJECT_ROOT, entry.packPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load contracted plugin pack: ${packPath}`, { cause: error });
  }
  if (!Array.isArray(manifest.skills) || !manifest.skills.length)
    throw new Error(`Contracted plugin pack contains no skills: ${packPath}`);
  const seen = new Set(skills.map(({ id }) => id));
  return manifest.skills.map((skill) => {
    if (
      !skill ||
      typeof skill.id !== "string" ||
      !skill.id.trim() ||
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      typeof skill.prompt !== "string" ||
      seen.has(skill.id)
    )
      throw new Error(`Invalid or duplicate skill in contracted plugin pack: ${packPath}`);
    seen.add(skill.id);
    return { id: skill.id, skill };
  });
}

function explicitInvocationMatches(skill, prompt) {
  const query = normalizeSkillInvocationText(sanitizeRoutingQuery(prompt));
  const aliases = [skill.id, skill.name].filter(Boolean);
  return aliases.some((phrase) =>
    matchesExplicitSkillInvocationPhrase(
      query,
      normalizeSkillInvocationText(phrase),
      (segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      aliases,
    ),
  );
}

export function evaluateRouting(skills, datasetPath, { contracts } = {}) {
  const dataset = loadDataset(datasetPath);
  const corpus = {
    positiveExamples: skills.reduce(
      (sum, { skill }) => sum + (skill.metadata?.routing?.examples?.positive?.length || 0),
      0,
    ),
    negativeExamples: skills.reduce(
      (sum, { skill }) => sum + (skill.metadata?.routing?.examples?.negative?.length || 0),
      0,
    ),
    datasetRows: dataset.length,
    datasetExpectedCases: dataset.filter((row) => row.expectedSkillIds?.length > 0).length,
    datasetForbiddenCases: dataset.filter((row) => row.forbiddenSkillIds?.length > 0).length,
  };
  const byKey = contracts ? validateContracts(contracts, corpus) : new Map();
  const matched = new Set();
  const contractResults = [];
  const failures = [];
  const rankings = new Map();
  const baseRank = (prompt) => {
    if (!rankings.has(prompt)) rankings.set(prompt, rankSkills(prompt, skills));
    return rankings.get(prompt);
  };
  let expectedTotal = 0;
  let expectedHits = 0;
  let forbiddenTotal = 0;
  let forbiddenMisfires = 0;
  let policyTotal = 0;
  let policyHits = 0;
  let installedPackTotal = 0;
  let installedPackHits = 0;

  const expected = (source, skillId, prompt, expectedIds, rankLimit) => {
    const key = contractKey({ source, skillId, prompt });
    const contract = byKey.get(key);
    let ranked = baseRank(prompt);
    if (contract) {
      if (matched.has(key))
        throw new Error(`Routing contract matches multiple source cases: ${skillId}`);
      matched.add(key);
      const reasons = [];
      if (contract.kind === "installed_pack") {
        installedPackTotal += 1;
        if (skills.some(({ id }) => id === skillId)) reasons.push("retired_skill_present");
        if (skills.some(({ id }) => id === contract.packSkillId))
          reasons.push("pack_skill_globally_exposed");
        const packSkills = loadPackSkills(contract, skills);
        if (!packSkills.some(({ id }) => id === contract.packSkillId))
          throw new Error(`Contracted pack skill not found: ${contract.packSkillId}`);
        ranked = rankSkills(prompt, [...skills, ...packSkills]);
        expectedTotal += 1;
        const hit = ranked.slice(0, rankLimit).some(({ id }) => id === contract.packSkillId);
        if (!hit) reasons.push("installed_pack_rank_miss");
        if (hit) {
          expectedHits += 1;
          if (!reasons.length) installedPackHits += 1;
        }
      } else {
        policyTotal += 1;
        const skill = skills.find(({ id }) => id === skillId)?.skill;
        if (!skill) throw new Error(`Contracted routing skill not found: ${skillId}`);
        const observed = {
          enabled: skill.enabled !== false,
          type: skill.type || "task",
          disableModelInvocation: skill.invocation?.disableModelInvocation === true,
          userInvocable: skill.invocation?.userInvocable !== false,
        };
        for (const [field, value] of Object.entries(contract.policy)) {
          if (observed[field] !== value) reasons.push(`policy_snapshot_${field}`);
        }
        if (contract.kind === "manual_only" && observed.type === "guideline")
          reasons.push("manual_skill_became_guideline");
        if (contract.kind === "explicit_only") {
          if (observed.type === "guideline" || observed.disableModelInvocation)
            reasons.push("explicit_skill_became_non_invocable");
          if (explicitInvocationMatches(skill, prompt)) reasons.push("explicit_invocation_matched");
        }
        const candidate = ranked.find(({ id }) => id === skillId);
        if (candidate) reasons.push("protected_skill_in_candidates");
        if (!reasons.length) policyHits += 1;
      }
      const result = {
        ...contract,
        passed: reasons.length === 0,
        reasons,
        ranked: ranked.slice(0, 5),
      };
      contractResults.push(result);
      if (reasons.length) failures.push({ ...result, source: "contract", contractSource: source });
      return ranked;
    }
    expectedTotal += 1;
    if (ranked.slice(0, rankLimit).some(({ id }) => expectedIds.includes(id))) expectedHits += 1;
    else
      failures.push({
        source,
        ...(source === "positive_example" ? { skillId } : {}),
        prompt,
        expectedSkillIds: expectedIds,
        ranked: ranked.slice(0, 5),
      });
    return ranked;
  };
  const forbidden = (source, skillId, prompt, forbiddenIds, ranked) => {
    forbiddenTotal += 1;
    if (forbiddenIds.includes(ranked[0]?.id)) {
      forbiddenMisfires += 1;
      failures.push({
        source,
        ...(source === "negative_example" ? { skillId } : {}),
        prompt,
        forbiddenSkillIds: forbiddenIds,
        ranked: ranked.slice(0, 5),
      });
    }
  };
  for (const { id, skill } of skills) {
    for (const prompt of skill.metadata?.routing?.examples?.positive || [])
      expected("positive_example", id, prompt, [id], 1);
    for (const prompt of skill.metadata?.routing?.examples?.negative || [])
      forbidden("negative_example", id, prompt, [id], baseRank(prompt));
  }
  for (const row of dataset) {
    const expectedIds = row.expectedSkillIds || [];
    if (expectedIds.length)
      expected(
        "dataset_expected",
        expectedIds.length === 1 ? expectedIds[0] : null,
        row.prompt,
        expectedIds,
        3,
      );
    if (row.forbiddenSkillIds?.length)
      forbidden("dataset_forbidden", null, row.prompt, row.forbiddenSkillIds, baseRank(row.prompt));
  }
  for (const [key, entry] of byKey) {
    if (!matched.has(key))
      throw new Error(`Unmatched or stale routing contract: ${entry.skillId} ${entry.prompt}`);
  }
  for (const failure of failures) {
    if (!failure.expectedSkillIds) continue;
    failure.expectedEligibility = Object.fromEntries(
      failure.expectedSkillIds.map((id) => {
        const skill = skills.find((entry) => entry.id === id)?.skill;
        const reason = !skill
          ? "skill_missing"
          : skill.type === "guideline"
            ? "guideline"
            : skill.enabled === false
              ? "skill_disabled"
              : !isModelInvocableSkill(skill)
                ? "model_invocation_disabled"
                : !matchesSkillRoutingQuery(skill, failure.prompt)
                  ? "routing_gate"
                  : "ranked_below_expected";
        return [id, reason];
      }),
    );
  }
  return {
    mode: "production_routing",
    corpus,
    expectedTotal,
    expectedHits,
    baseExpectedTotal: expectedTotal - installedPackTotal,
    originalExpectedTotal: expectedTotal + policyTotal,
    forbiddenTotal,
    forbiddenMisfires,
    expectedHitRate: expectedTotal === 0 ? 1 : expectedHits / expectedTotal,
    forbiddenMisfireRate: forbiddenTotal === 0 ? 0 : forbiddenMisfires / forbiddenTotal,
    policyTotal,
    policyHits,
    installedPackTotal,
    installedPackHits,
    contractTotal: byKey.size,
    contractMatched: matched.size,
    contractFailures: contractResults.filter(({ passed }) => !passed).length,
    contractResults,
    failures,
  };
}

function loadHintCases(hintCasesPath) {
  if (!fs.existsSync(hintCasesPath)) throw new Error(`Hint cases not found: ${hintCasesPath}`);
  return fs
    .readFileSync(hintCasesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const row = JSON.parse(line);
        if (
          typeof row.prompt !== "string" ||
          !row.prompt.trim() ||
          !Array.isArray(row.hintSkillIds) ||
          !row.hintSkillIds.every((id) => typeof id === "string" && id.trim())
        )
          throw new Error("A hint case requires a prompt and hintSkillIds ([] = no hint)");
        return row;
      } catch (error) {
        throw new Error(`Invalid hint case at ${hintCasesPath}:${index + 1}`, { cause: error });
      }
    });
}

/**
 * Score the planning-hint rule the executor applies to the same ranking.
 * Routing dataset rows only count wrong hints; hint cases also require the hint
 * to fire (hintSkillIds) or to stay silent ([]).
 */
export function evaluatePlanningHints(skills, datasetPath, hintCasesPath) {
  const hintsFor = (prompt) =>
    selectSkillPlanningHints(
      rankModelInvocableSkillsForQuery(
        skills.map((item) => item.skill),
        prompt,
      ),
    ).hints.map(({ skill, score }) => ({ id: skill.id, score }));
  const report = {
    datasetTotal: 0,
    datasetHinted: 0,
    datasetWrong: 0,
    casesTotal: 0,
    casesPassed: 0,
    positiveCases: 0,
    positiveHinted: 0,
    negativeCases: 0,
    negativeMisfires: 0,
    failures: [],
  };
  for (const row of loadDataset(datasetPath)) {
    if (!row.expectedSkillIds?.length) continue;
    report.datasetTotal += 1;
    const hints = hintsFor(row.prompt);
    if (!hints.length) continue;
    report.datasetHinted += 1;
    if (!row.expectedSkillIds.includes(hints[0].id)) {
      report.datasetWrong += 1;
      report.failures.push({
        source: "dataset",
        prompt: row.prompt,
        expected: row.expectedSkillIds,
        hints,
      });
    }
  }
  for (const row of hintCasesPath ? loadHintCases(hintCasesPath) : []) {
    report.casesTotal += 1;
    const hints = hintsFor(row.prompt);
    const expectHint = row.hintSkillIds.length > 0;
    if (expectHint) report.positiveCases += 1;
    else report.negativeCases += 1;
    if (expectHint && hints.length && row.hintSkillIds.includes(hints[0].id)) {
      report.positiveHinted += 1;
      report.casesPassed += 1;
    } else if (!expectHint && !hints.length) {
      report.casesPassed += 1;
    } else {
      if (!expectHint) report.negativeMisfires += 1;
      report.failures.push({
        source: "hint_case",
        prompt: row.prompt,
        expected: row.hintSkillIds,
        hints,
      });
    }
  }
  return report;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const skills = loadSkills(args.skillsDir);
  if (args.liveModel)
    throw new Error(
      "Live model routing evaluation is not implemented; use the production deterministic router.",
    );
  const isBundled =
    path.resolve(args.skillsDir) === BUNDLED_SKILLS_DIR &&
    path.resolve(args.datasetPath) === BUNDLED_DATASET;
  const contractsPath = args.contractsPath || (isBundled ? BUNDLED_CONTRACTS : null);
  let contracts;
  if (contractsPath) {
    try {
      contracts = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot load routing contracts: ${contractsPath}`, { cause: error });
    }
  }
  const report = evaluateRouting(skills, args.datasetPath, { contracts });
  const hintCasesPath = args.hintCasesPath || (isBundled ? BUNDLED_HINT_CASES : null);
  const hints = evaluatePlanningHints(skills, args.datasetPath, hintCasesPath);
  report.planningHints = hints;
  console.log(`[skills-eval-routing] Skills: ${skills.length}`);
  console.log(
    "[skills-eval-routing] Mode: production deterministic routing (shared runtime scorer and gates)",
  );
  console.log(
    `[skills-eval-routing] Expected hit rate: ${(report.expectedHitRate * 100).toFixed(2)}% (${report.expectedHits}/${report.expectedTotal})`,
  );
  console.log(
    `[skills-eval-routing] Forbidden misfire rate: ${(report.forbiddenMisfireRate * 100).toFixed(2)}% (${report.forbiddenMisfires}/${report.forbiddenTotal})`,
  );
  console.log(
    `[skills-eval-routing] Policy contracts: ${report.policyHits}/${report.policyTotal}; installed-pack cases: ${report.installedPackHits}/${report.installedPackTotal}; matched contracts: ${report.contractMatched}/${report.contractTotal}`,
  );
  console.log(
    `[skills-eval-routing] Preserved expected obligations: ${report.baseExpectedTotal} base + ${report.installedPackTotal} installed + ${report.policyTotal} policy = ${report.originalExpectedTotal}; contract failures: ${report.contractFailures}`,
  );
  console.log(
    `[skills-eval-routing] Planning hints: dataset ${hints.datasetHinted}/${hints.datasetTotal} hinted, ${hints.datasetWrong} wrong; hint cases ${hints.casesPassed}/${hints.casesTotal} passed (${hints.positiveHinted}/${hints.positiveCases} hinted, ${hints.negativeMisfires}/${hints.negativeCases} negatives misfired)`,
  );
  for (const failure of hints.failures)
    console.log(
      `[skills-eval-routing]   hint ${failure.source} failure: "${failure.prompt}" expected [${failure.expected.join(", ")}], hinted [${failure.hints.map(({ id }) => id).join(", ")}]`,
    );
  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`[skills-eval-routing] Failure report: ${args.reportPath}`);
  }
  if (
    args.strict &&
    (report.contractFailures > 0 ||
      report.expectedHitRate < 0.95 ||
      report.forbiddenMisfireRate > 0.02 ||
      hints.failures.length > 0)
  ) {
    console.log("[skills-eval-routing] Strict threshold failure");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
