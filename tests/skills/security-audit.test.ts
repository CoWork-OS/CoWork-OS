import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptsDir = resolve(__dirname, "../../resources/skills/security-audit/scripts");
const UNIT_ID = "http-api::user-to-other-user::project-api::access-control";
const FINGERPRINT = "access-control/project-api/missing-owner-check-on-export";

type Json = Record<string, unknown>;

function unit(overrides: Json = {}): Json {
  return {
    id: UNIT_ID,
    surface: "http-api",
    boundary: "user-to-other-user",
    component: "project-api",
    attack_class: "access-control",
    start_paths: ["src/server/routes/projects.ts"],
    status: "candidate",
    agent: "hunter-w1-03",
    wave: 1,
    read_paths: ["src/server/routes/projects.ts"],
    checks: [
      {
        invariant: "Only members can export a project",
        method: "source",
        result: "No owner filter at projects.ts:141",
      },
    ],
    fingerprints: [FINGERPRINT],
    reason: null,
    attempts: [],
    ...overrides,
  };
}

function confirmed(overrides: Json = {}): Json {
  return {
    fingerprint: FINGERPRINT,
    verdict: "confirmed",
    title: "Any signed-in user can export another user's project",
    attack_class: "access-control",
    coverage_ids: [UNIT_ID],
    origin: "hunted",
    found_by: "hunter-w1-03",
    verification: { challenge: "challenger-01", recheck: "rechecker-01" },
    location: { path: "src/server/routes/projects.ts", line: 141 },
    attacker: "Any signed-in user",
    trace: {
      entry: "projects.ts:138 GET /projects/:id/export",
      steps: ["projects.ts:141 loads by id with no owner filter"],
      sink: "projects.ts:150 streams the archive",
    },
    evidence: [{ ref: "src/server/routes/projects.ts:141", note: "findById has no ownerId" }],
    impact: "Read access to every project",
    preconditions: [],
    reproduction: { method: "source", steps: ["Request another user's export"], observed: null },
    fix: { summary: "Check membership before loading", patch: null },
    severity: { likelihood: "high", impact: "high", overall: "high" },
    confidence: "high",
    ...overrides,
  };
}

describe("security-audit skill checkers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cowork-security-audit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, data: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  function run(script: string, args: string[]) {
    const result = spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
      encoding: "utf8",
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  function checkLedger(units: Json[], final = false) {
    const path = write("ledger.json", { version: 1, units });
    return run("check-ledger.mjs", final ? ["--final", path] : [path]);
  }

  function checkFindings(findings: Json[], depth = "standard", units: Json[] | null = null) {
    const findingsPath = write("findings.json", { version: 1, depth, findings });
    const args = [findingsPath];
    if (units) args.push("--ledger", write("ledger.json", { version: 1, units }));
    return run("check-findings.mjs", args);
  }

  it("accepts a consistent ledger and findings file", () => {
    expect(checkLedger([unit()], true).status).toBe(0);
    const result = checkFindings([confirmed()], "standard", [unit()]);
    expect(result.out).toContain("1 confirmed (critical 0, high 1");
    expect(result.status).toBe(0);
  });

  it("enforces what each unit status requires", () => {
    const coveredWithoutWork = checkLedger([
      unit({ status: "covered", fingerprints: [], read_paths: [], checks: [] }),
    ]);
    expect(coveredWithoutWork.status).toBe(1);
    expect(coveredWithoutWork.out).toContain("status requires read_paths");
    expect(coveredWithoutWork.out).toContain("status requires checks");

    const blockedWithoutReason = checkLedger([unit({ status: "blocked", fingerprints: [] })]);
    expect(blockedWithoutReason.out).toContain("status requires reason");

    const plannedWithAgent = checkLedger([
      unit({ status: "planned", fingerprints: [], read_paths: [], checks: [] }),
    ]);
    expect(plannedWithAgent.out).toContain("status does not allow agent");
  });

  it("rejects planned units once hunting has ended", () => {
    const planned = unit({
      status: "planned",
      agent: null,
      fingerprints: [],
      read_paths: [],
      checks: [],
    });
    expect(checkLedger([planned]).status).toBe(0);
    const final = checkLedger([planned], true);
    expect(final.status).toBe(1);
    expect(final.out).toContain("still planned after hunting ended");
  });

  it("rejects ids that do not match their parts, unknown classes and unknown fields", () => {
    const result = checkLedger([
      unit({ id: "http-api::wrong", attack_class: "magic", extra: true }),
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('unknown attack_class "magic"');
    expect(result.out).toContain('unknown field "extra"');
    expect(result.out).toContain('id must be "http-api::user-to-other-user::project-api::magic"');
  });

  it("rejects duplicate unit ids", () => {
    const result = checkLedger([unit(), unit()]);
    expect(result.out).toContain("duplicate id");
  });

  it("does not allow severity outside confirmed records", () => {
    const needsValidation = confirmed({
      verdict: "needs_validation",
      reproduction: undefined,
      blockers: ["Deployment config not visible"],
      validation_plan: ["Check the gateway rule (deployment access)"],
    });
    delete needsValidation.reproduction;
    const result = checkFindings([needsValidation]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('field "severity" is not allowed for needs_validation');
    expect(result.out).toContain('field "confidence" is not allowed for needs_validation');
  });

  it("requires rejected records to give a reason", () => {
    const rejected: Json = {
      fingerprint: FINGERPRINT,
      verdict: "rejected",
      title: "Export without owner check",
      attack_class: "access-control",
      coverage_ids: [UNIT_ID],
      origin: "hunted",
      found_by: "hunter-w1-03",
      verification: { challenge: "challenger-01", recheck: null },
      location: { path: "src/server/routes/projects.ts" },
      trace: { entry: "projects.ts:138", steps: [], sink: "projects.ts:150" },
      evidence: [{ ref: "src/server/middleware.ts:12", note: "membership middleware" }],
    };
    expect(checkFindings([rejected]).out).toContain('missing field "reason"');
    const withReason = checkFindings([{ ...rejected, reason: "middleware.ts:12 checks it" }]);
    expect(withReason.status).toBe(0);
  });

  it("keeps the finder, challenger and re-checker apart", () => {
    const selfChallenged = checkFindings([
      confirmed({ verification: { challenge: "hunter-w1-03", recheck: "rechecker-01" } }),
    ]);
    expect(selfChallenged.out).toContain("must not be the agent that found it");

    const sameChecker = checkFindings([
      confirmed({ verification: { challenge: "challenger-01", recheck: "challenger-01" } }),
    ]);
    expect(sameChecker.out).toContain("re-checker must differ");
  });

  it("requires a re-check except in quick runs", () => {
    const unchecked = confirmed({ verification: { challenge: "challenger-01", recheck: null } });
    expect(checkFindings([unchecked], "standard").out).toContain(
      "verification.recheck must name the re-checker",
    );
    expect(checkFindings([unchecked], "quick").status).toBe(0);
  });

  it("requires findings sorted by fingerprint with no duplicates", () => {
    const first = confirmed({ fingerprint: "b/one/x" });
    const second = confirmed({ fingerprint: "a/two/y" });
    expect(checkFindings([first, second]).out).toContain("must be sorted by fingerprint");
    expect(checkFindings([second, second]).out).toContain("duplicate fingerprint");
  });

  it("requires observed output for a local reproduction", () => {
    const result = checkFindings([
      confirmed({ reproduction: { method: "local", steps: ["Run the proof"], observed: null } }),
    ]);
    expect(result.out).toContain("a local reproduction needs observed output");
  });

  it("cross-checks candidates and coverage ids against the ledger", () => {
    const extraCandidate = unit({ fingerprints: [FINGERPRINT, "injection/project-api/sort"] });
    const missingRecord = checkFindings([confirmed()], "standard", [extraCandidate]);
    expect(missingRecord.status).toBe(1);
    expect(missingRecord.out).toContain('candidate "injection/project-api/sort" has no record');

    const unknownUnit = checkFindings(
      [confirmed({ coverage_ids: ["cli::local-user::config::injection"] })],
      "standard",
      [unit()],
    );
    expect(unknownUnit.out).toContain("is not in the ledger");
  });

  it("marks carried records as found by an earlier run", () => {
    const result = checkFindings([confirmed({ origin: "carried" })]);
    expect(result.out).toContain('a carried record has found_by "earlier-run"');
    const carried = confirmed({ origin: "carried", found_by: "earlier-run" });
    expect(
      checkFindings([carried], "standard", [unit({ fingerprints: [], status: "covered" })]).status,
    ).toBe(0);
  });

  it("reports unreadable input and bad usage", () => {
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{not json");
    expect(run("check-ledger.mjs", [badJson]).out).toContain("is not valid JSON");
    expect(run("check-findings.mjs", []).status).toBe(2);
  });
});
