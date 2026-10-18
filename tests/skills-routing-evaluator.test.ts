import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import type { CustomSkill } from "../src/shared/types";

const directories: string[] = [];
const evaluator = resolve("scripts/qa/eval-skills-routing.mjs");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function evaluateReports(
  routing: Record<string, unknown>,
  description = "Compose reports",
  forbiddenSkillIds = ["reports"],
) {
  const directory = mkdtempSync(join(tmpdir(), "cowork-skill-routing-eval-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "reports.json"),
    JSON.stringify({
      id: "reports",
      name: "Reports",
      description,
      metadata: { routing: { useWhen: "Compose reports", ...routing } },
    }),
  );
  writeFileSync(
    join(directory, "music.json"),
    JSON.stringify({
      id: "music",
      name: "Music",
      description:
        "play jazz music audio recordings albums composers performances instruments concerts players",
    }),
  );
  const dataset = join(directory, "cases.jsonl");
  writeFileSync(
    dataset,
    JSON.stringify({
      prompt: "play jazz music",
      expectedSkillIds: ["music"],
      forbiddenSkillIds,
    }) + "\n",
  );
  return spawnSync(
    process.execPath,
    [evaluator, "--skills-dir", directory, "--dataset", dataset, "--strict"],
    { encoding: "utf8", timeout: 10_000 },
  );
}

function contractFixture(kind: "manual_only" | "guideline" | "explicit_only" = "manual_only") {
  const directory = mkdtempSync(join(tmpdir(), "cowork-routing-contract-"));
  directories.push(directory);
  const prompt =
    kind === "explicit_only"
      ? "Gemini: provide an actionable result."
      : "Analyze ledger rows for invoice trends.";
  const id = kind === "explicit_only" ? "gemini" : "manual";
  const base = (id: string, overrides: Partial<CustomSkill> = {}): CustomSkill => ({
    id,
    name: id,
    description: "Analyze ledger rows for invoice trends.",
    prompt: "Inspect the requested data.",
    icon: "x",
    category: "Data",
    parameters: [],
    enabled: true,
    ...overrides,
  });
  const protectedSkill = base(id, {
    name: kind === "explicit_only" ? "Gemini" : "Manual archival helper",
    description: "Archive a reference note.",
    ...(kind === "manual_only" ? { invocation: { disableModelInvocation: true } } : {}),
    ...(kind === "guideline" ? { type: "guideline" as const } : {}),
    metadata: { routing: { examples: { positive: [prompt], negative: [] } } },
  });
  const entries = [protectedSkill, base("ordinary"), base("analysis"), base("invoices")].map(
    (skill) => ({ id: skill.id, skill }),
  );
  const dataset = join(directory, "cases.jsonl");
  writeFileSync(
    dataset,
    JSON.stringify({
      prompt: "Use ordinary to analyze ledger rows.",
      expectedSkillIds: ["ordinary"],
      forbiddenSkillIds: [id],
    }) + "\n",
  );
  const contracts = {
    version: 1,
    corpus: {
      positiveExamples: 1,
      negativeExamples: 0,
      datasetRows: 1,
      datasetExpectedCases: 1,
      datasetForbiddenCases: 1,
      contractsByKind: {
        manual_only: 0,
        guideline: 0,
        explicit_only: 0,
        installed_pack: 0,
        [kind]: 1,
      },
    },
    cases: [
      {
        source: "positive_example",
        skillId: id,
        prompt,
        kind,
        evidence: "Independent fixture policy contract.",
        policy: {
          enabled: true,
          ...(kind === "manual_only" ? { disableModelInvocation: true, userInvocable: true } : {}),
          ...(kind === "guideline" ? { type: "guideline" } : {}),
        },
      },
    ],
  };
  return { directory, dataset, entries, contracts, protectedSkill };
}

describe("production skill routing evaluator", () => {
  it("loads the production scorer in native Node without module-format warnings", () => {
    const source = pathToFileURL(resolve("src/shared/skill-routing/index.ts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import * as scorer from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify(Object.keys(scorer)));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining(["rankModelInvocableSkillsForQuery", "isModelInvocableSkill"]),
    );
  });

  it.each([
    [
      "Show the HyperFrames CLI commands for initializing and previewing this composition.",
      "hyperframes-cli",
    ],
    ["Analyze a CSV of monthly revenue and describe the trends.", "analyze-csv"],
    ["Review the proposed Terraform changes and flag infrastructure risks.", "terraform-ops"],
    ["Create a motion-design editor with keyframes, a timeline, and MP4 export.", "motion-editor"],
    ["Build the frontend, then test its behavior in a browser.", "playwright-qa"],
    ["Monitor a competitor's blog every week and report new changes.", "content-monitor"],
    [
      "Review this patch for needless rewrites and complicated abstractions.",
      "code-review|code-reviewer",
    ],
  ])("routes a supported task paraphrase: %s", async (query, expected) => {
    const { loadSkills, rankSkills } = await import("../scripts/qa/eval-skills-routing.mjs");
    const ranked = rankSkills(query, loadSkills(resolve("resources/skills")));
    expect(ranked.slice(0, 3).some(({ id }) => expected.split("|").includes(id))).toBe(true);
  });

  it.each([{ dontUseWhen: "play jazz music" }, { examples: { negative: ["play jazz music"] } }])(
    "keeps exclusion evidence out of the positive signal: %s",
    (routing) => {
      const result = evaluateReports(routing);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Forbidden misfire rate: 0.00%");
    },
  );

  it.each([{}, { examples: { negative: ["play jazz music"] } }])(
    "still fails strict mode when positive descriptions select a forbidden match: %s",
    (routing) => {
      const result = evaluateReports(routing, "play jazz music", ["music"]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      const expectedRate = "examples" in routing ? "50.00%" : "100.00%";
      expect(result.stdout).toContain(`Forbidden misfire rate: ${expectedRate}`);
      expect(result.stdout).toContain("Strict threshold failure");
    },
  );

  it("keeps intentionally non-invocable positive cases in the failure counts and report", async () => {
    const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
    const directory = mkdtempSync(join(tmpdir(), "cowork-skill-routing-eligibility-"));
    directories.push(directory);
    const dataset = join(directory, "cases.jsonl");
    writeFileSync(
      dataset,
      JSON.stringify({ prompt: "Use manual.", expectedSkillIds: ["manual"] }) + "\n",
    );
    const report = evaluateRouting(
      [
        {
          id: "manual",
          skill: {
            id: "manual",
            name: "Manual",
            invocation: { disableModelInvocation: true },
            metadata: { routing: { examples: { positive: ["Use manual."], negative: [] } } },
          },
        },
      ],
      dataset,
    );
    expect(report.expectedTotal).toBe(2);
    expect(report.expectedHits).toBe(0);
    expect(report.failures).toHaveLength(2);
    expect(
      report.failures.every(
        (failure) => failure.expectedEligibility.manual === "model_invocation_disabled",
      ),
    ).toBe(true);
  });

  it("fails instead of silently discarding a malformed or absent evaluation dataset", async () => {
    const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
    const directory = mkdtempSync(join(tmpdir(), "cowork-skill-routing-invalid-"));
    directories.push(directory);
    const dataset = join(directory, "cases.jsonl");
    expect(() => evaluateRouting([], dataset)).toThrow("Routing dataset not found");
    writeFileSync(dataset, "{invalid json}\n");
    expect(() => evaluateRouting([], dataset)).toThrow("Invalid routing case");
  });

  it.each(["manual_only", "guideline", "explicit_only"] as const)(
    "preserves a %s prompt as an independent policy assertion",
    async (kind) => {
      const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
      const fixture = contractFixture(kind);
      const report = evaluateRouting(fixture.entries, fixture.dataset, {
        contracts: fixture.contracts,
      });
      expect(report).toMatchObject({
        expectedTotal: 1,
        expectedHits: 1,
        originalExpectedTotal: 2,
        forbiddenTotal: 1,
        forbiddenMisfires: 0,
        policyTotal: 1,
        policyHits: 1,
        contractTotal: 1,
        contractMatched: 1,
        contractFailures: 0,
      });
      expect(report.contractResults[0].prompt).toBe(fixture.contracts.cases[0].prompt);
      expect(report.failures).toEqual([]);
    },
  );

  it("detects a protected candidate below the first three ranks as well as policy drift", async () => {
    const { evaluateRouting, rankSkills } = await import("../scripts/qa/eval-skills-routing.mjs");
    const fixture = contractFixture();
    fixture.protectedSkill.invocation!.disableModelInvocation = false;
    for (const { skill } of fixture.entries.slice(1))
      skill.metadata = {
        routing: {
          examples: {
            positive: [fixture.contracts.cases[0].prompt],
            negative: [],
          },
        },
      };
    fixture.contracts.corpus.positiveExamples = 4;
    const ranked = rankSkills(fixture.contracts.cases[0].prompt, fixture.entries);
    expect(ranked.findIndex(({ id }) => id === "manual")).toBeGreaterThanOrEqual(3);
    const report = evaluateRouting(fixture.entries, fixture.dataset, {
      contracts: fixture.contracts,
    });
    expect(report.policyHits).toBe(0);
    expect(report.contractFailures).toBe(1);
    expect(report.contractResults[0].reasons).toEqual(
      expect.arrayContaining([
        "policy_snapshot_disableModelInvocation",
        "protected_skill_in_candidates",
      ]),
    );
  });

  it.each(["manual_only", "guideline"] as const)(
    "fails a %s snapshot mutation even when the protected skill cannot rank",
    async (kind) => {
      const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
      const fixture = contractFixture(kind);
      fixture.protectedSkill.enabled = false;
      const report = evaluateRouting(fixture.entries, fixture.dataset, {
        contracts: fixture.contracts,
      });
      expect(report.contractFailures).toBe(1);
      expect(report.contractResults[0].reasons).toContain("policy_snapshot_enabled");
      expect(report.contractResults[0].reasons).not.toContain("protected_skill_in_candidates");
    },
  );

  it("detects changing a contracted guideline into an invocable task", async () => {
    const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
    const fixture = contractFixture("guideline");
    fixture.protectedSkill.type = "task";
    const report = evaluateRouting(fixture.entries, fixture.dataset, {
      contracts: fixture.contracts,
    });
    expect(report.contractFailures).toBe(1);
    expect(report.contractResults[0].reasons).toContain("policy_snapshot_type");
  });

  it("checks explicit invocation itself even if eligibility filters hide the skill", async () => {
    const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
    const fixture = contractFixture("explicit_only");
    const prompt = "Use Gemini to summarize this text.";
    fixture.protectedSkill.metadata!.routing!.examples!.positive = [prompt];
    fixture.contracts.cases[0].prompt = prompt;
    fixture.protectedSkill.invocation = { disableModelInvocation: true };
    const report = evaluateRouting(fixture.entries, fixture.dataset, {
      contracts: fixture.contracts,
    });
    expect(report.contractFailures).toBe(1);
    expect(report.contractResults[0].reasons).toEqual(
      expect.arrayContaining([
        "explicit_invocation_matched",
        "explicit_skill_became_non_invocable",
      ]),
    );
    expect(report.contractResults[0].reasons).not.toContain("protected_skill_in_candidates");
  });

  it.each(["missing", "duplicate", "stale", "corpus", "policy"])(
    "rejects %s contract coverage instead of skipping it",
    async (mutation) => {
      const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
      const fixture = contractFixture();
      if (mutation === "missing") fixture.contracts.cases = [];
      if (mutation === "duplicate") {
        fixture.contracts.cases.push({ ...fixture.contracts.cases[0] });
        fixture.contracts.corpus.contractsByKind.manual_only = 2;
      }
      if (mutation === "stale") fixture.contracts.cases[0].prompt += " Changed.";
      if (mutation === "corpus") fixture.contracts.corpus.positiveExamples += 1;
      if (mutation === "policy") delete (fixture.contracts.cases[0] as { policy?: unknown }).policy;
      const pattern =
        mutation === "duplicate"
          ? /Duplicate routing contract/
          : mutation === "stale"
            ? /Unmatched or stale routing contract/
            : mutation === "policy"
              ? /Missing independent policy snapshot/
              : /(?:coverage|corpus) drift/;
      expect(() =>
        evaluateRouting(fixture.entries, fixture.dataset, { contracts: fixture.contracts }),
      ).toThrow(pattern);
    },
  );

  it.each(["expectedSkillIds", "forbiddenSkillIds"])(
    "rejects removing %s while retaining a valid dataset row",
    async (field) => {
      const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
      const fixture = contractFixture();
      const row = JSON.parse(readFileSync(fixture.dataset, "utf8"));
      delete row[field];
      writeFileSync(fixture.dataset, JSON.stringify(row) + "\n");
      expect(() =>
        evaluateRouting(fixture.entries, fixture.dataset, { contracts: fixture.contracts }),
      ).toThrow(/Routing contract corpus drift: dataset(?:Expected|Forbidden)Cases/);
    },
  );

  it("makes any policy contract failure fatal to strict CLI evaluation", () => {
    const fixture = contractFixture();
    fixture.protectedSkill.invocation!.disableModelInvocation = false;
    for (const { id, skill } of fixture.entries)
      writeFileSync(join(fixture.directory, id + ".json"), JSON.stringify(skill));
    const contractPath = join(fixture.directory, "contracts.sidecar");
    writeFileSync(contractPath, JSON.stringify(fixture.contracts));
    const result = spawnSync(
      process.execPath,
      [
        evaluator,
        "--skills-dir",
        fixture.directory,
        "--dataset",
        fixture.dataset,
        "--contracts",
        contractPath,
        "--strict",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("Expected hit rate: 100.00%");
    expect(result.stdout).toContain("contract failures: 1");
    expect(result.stdout).toContain("Strict threshold failure");
  });

  it("preserves the reviewed bundled contract inventory and original source prompts", async () => {
    const { loadSkills } = await import("../scripts/qa/eval-skills-routing.mjs");
    const contracts = JSON.parse(
      readFileSync(resolve("resources/skills/_evals/routing-contracts.json"), "utf8"),
    );
    expect(contracts.corpus).toEqual({
      positiveExamples: 629,
      negativeExamples: 613,
      datasetRows: 32,
      datasetExpectedCases: 32,
      datasetForbiddenCases: 32,
      contractsByKind: { manual_only: 8, guideline: 6, explicit_only: 2, installed_pack: 1 },
    });
    expect(contracts.cases).toHaveLength(17);
    const skills = loadSkills(resolve("resources/skills"));
    const dataset = readFileSync(resolve("resources/skills/_evals/routing-cases.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    for (const contract of contracts.cases) {
      if (contract.source === "positive_example") {
        const skill = skills.find(({ id }) => id === contract.skillId)!.skill;
        expect(skill.metadata.routing.examples.positive).toContain(contract.prompt);
      } else {
        expect(dataset).toContainEqual(
          expect.objectContaining({
            prompt: contract.prompt,
            expectedSkillIds: [contract.skillId],
          }),
        );
      }
    }
  });

  it("routes the changelog only with the actual installed pack in its scoped scenario", async () => {
    const { evaluateRouting, loadSkills, rankSkills } =
      await import("../scripts/qa/eval-skills-routing.mjs");
    const skills = loadSkills(resolve("resources/skills")).filter(({ id }) =>
      ["git-commit", "translate"].includes(id),
    );
    const allContracts = JSON.parse(
      readFileSync(resolve("resources/skills/_evals/routing-contracts.json"), "utf8"),
    );
    const entry = allContracts.cases.find(({ kind }) => kind === "installed_pack");
    const fixture = contractFixture();
    // Keep real core skills and the actual pack without rerunning the full catalogue.
    writeFileSync(
      fixture.dataset,
      JSON.stringify({
        prompt: entry.prompt,
        expectedSkillIds: [entry.skillId],
        forbiddenSkillIds: ["translate"],
      }) + "\n",
    );
    const contracts = {
      version: 1,
      corpus: {
        positiveExamples: 8,
        negativeExamples: 8,
        datasetRows: 1,
        datasetExpectedCases: 1,
        datasetForbiddenCases: 1,
        contractsByKind: { manual_only: 0, guideline: 0, explicit_only: 0, installed_pack: 1 },
      },
      cases: [entry],
    };
    expect(skills.some(({ id }) => id === entry.packSkillId || id === entry.skillId)).toBe(false);
    const before = rankSkills(entry.prompt, skills);
    const report = evaluateRouting(skills, fixture.dataset, { contracts });
    expect(report).toMatchObject({
      installedPackTotal: 1,
      installedPackHits: 1,
      contractTotal: 1,
      contractMatched: 1,
      contractFailures: 0,
    });
    expect(report.contractResults[0].ranked.slice(0, 3).map(({ id }) => id)).toContain(
      entry.packSkillId,
    );
    expect(rankSkills(entry.prompt, skills)).toEqual(before);
  });

  it("keeps a base-catalogue forbidden failure when an installed pack outranks it", async () => {
    const { evaluateRouting } = await import("../scripts/qa/eval-skills-routing.mjs");
    const allContracts = JSON.parse(
      readFileSync(resolve("resources/skills/_evals/routing-contracts.json"), "utf8"),
    );
    const entry = allContracts.cases.find(({ kind }) => kind === "installed_pack");
    const fixture = contractFixture();
    const skills = [
      {
        id: "forbidden",
        skill: { id: "forbidden", name: "Weather", description: "Forecast weather." },
      },
    ];
    writeFileSync(
      fixture.dataset,
      JSON.stringify({
        prompt: entry.prompt,
        expectedSkillIds: [entry.skillId],
        forbiddenSkillIds: ["forbidden"],
      }) + "\n",
    );
    const contracts = {
      version: 1,
      corpus: {
        positiveExamples: 0,
        negativeExamples: 0,
        datasetRows: 1,
        datasetExpectedCases: 1,
        datasetForbiddenCases: 1,
        contractsByKind: { manual_only: 0, guideline: 0, explicit_only: 0, installed_pack: 1 },
      },
      cases: [entry],
    };
    const report = evaluateRouting(skills, fixture.dataset, { contracts });
    expect(report).toMatchObject({
      expectedTotal: 1,
      expectedHits: 1,
      installedPackHits: 1,
      contractFailures: 0,
      forbiddenTotal: 1,
      forbiddenMisfires: 1,
    });
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        source: "dataset_forbidden",
        ranked: [expect.objectContaining({ id: "forbidden" })],
      }),
    );
    // A ranking hit must not be reported as a passed installed contract when
    // the supposedly retired skill is present in the base catalogue.
    skills[0].id = entry.skillId;
    skills[0].skill.id = entry.skillId;
    const drifted = evaluateRouting(skills, fixture.dataset, { contracts });
    expect(drifted).toMatchObject({ expectedHits: 1, installedPackHits: 0, contractFailures: 1 });
    expect(drifted.contractResults[0].reasons).toContain("retired_skill_present");
  });
});
