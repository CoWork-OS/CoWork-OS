import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

describe.each(["release.yml", "nightly-hardening.yml"])("%s coverage gate", (filename) => {
  const workflow = yaml.load(fs.readFileSync(path.join(".github/workflows", filename), "utf8"));
  const job = workflow.jobs[filename === "release.yml" ? "hardening-release-gate" : "hardening"];
  const battery = job.steps.find((step: { id?: string }) => step.id === "run_battery");
  const gate = job.steps.find((step: { name: string }) => step.name.startsWith("Enforce "));

  it("does not hide a failed deterministic harness behind log piping", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-workflow-harness-"));
    try {
      fs.mkdirSync(path.join(dir, ".artifacts/hardening"), { recursive: true });
      fs.writeFileSync(path.join(dir, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const step = job.steps.find((entry: { id?: string }) => entry.id === "run_eval_suite");
      const result = spawnSync("bash", ["-c", step.run], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["absent", {}, "not_configured", 0],
    ["partial", { COWORK_HOOKS_ORIGIN: "http://example.invalid" }, "failed", 1],
    [
      "complete",
      {
        COWORK_HOOKS_ORIGIN: "http://example.invalid",
        COWORK_HOOKS_TOKEN: "fake",
        COWORK_DB_PATH: "fake.db",
      },
      "completed",
      0,
    ],
    [
      "failed",
      {
        COWORK_HOOKS_ORIGIN: "http://example.invalid",
        COWORK_HOOKS_TOKEN: "fake",
        COWORK_DB_PATH: "fake.db",
        FAKE_BATTERY_EXIT: "1",
      },
      "failed",
      1,
    ],
  ])(
    "reports and gates %s live configuration honestly",
    (_name, config, coverage, expectedExit) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-workflow-gate-"));
      try {
        fs.mkdirSync(path.join(dir, ".artifacts/hardening"), { recursive: true });
        // Execute the actual workflow shell without contacting a service or requiring GNU date.
        fs.writeFileSync(path.join(dir, "node"), '#!/bin/sh\nexit "${FAKE_BATTERY_EXIT:-0}"\n', {
          mode: 0o755,
        });
        fs.writeFileSync(path.join(dir, "date"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
        const output = path.join(dir, "outputs");
        const env = {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          COWORK_HOOKS_ORIGIN: "",
          COWORK_HOOKS_TOKEN: "",
          COWORK_DB_PATH: "",
          ...config,
        };
        const run = spawnSync("bash", ["-c", battery.run], { cwd: dir, env, encoding: "utf8" });
        expect(run.status).toBe(expectedExit);
        expect(fs.readFileSync(output, "utf8").trim().split("\n").at(-1)).toBe(
          `coverage=${coverage}`,
        );
        const gateResult = spawnSync("bash", ["-c", gate.run], {
          cwd: dir,
          env: {
            ...env,
            RUN_EVAL_OUTCOME: "success",
            RUN_BATTERY_OUTCOME: run.status === 0 ? "success" : "failure",
            BATTERY_COVERAGE: coverage,
            HARDENING_REQUIRED_AFTER_UTC: "2026-03-14T00:00:00Z",
          },
          encoding: "utf8",
        });
        expect(gateResult.status).toBe(expectedExit);
        if (coverage === "not_configured") expect(gateResult.stdout).toContain("not_configured");
        if (expectedExit === 0) {
          expect(() =>
            execFileSync("bash", ["-c", gate.run], {
              cwd: dir,
              env: {
                ...env,
                RUN_EVAL_OUTCOME: "failure",
                RUN_BATTERY_OUTCOME: "success",
                BATTERY_COVERAGE: coverage,
                HARDENING_REQUIRED_AFTER_UTC: "2026-03-14T00:00:00Z",
              },
              stdio: "pipe",
            }),
          ).toThrow();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
