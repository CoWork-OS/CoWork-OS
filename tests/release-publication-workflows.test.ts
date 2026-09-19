import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
type Step = {
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Job = { steps: Step[]; needs?: string[]; if?: string; env: Record<string, string> };
type Workflow = {
  jobs: Record<string, Job>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};
const read = (name: string) =>
  yaml.load(fs.readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow;
const release = read("release.yml");
const recovery = read("recover-registry-publication.yml");
const commands = (job: Job) => job.steps.map((step: Step) => step.run || "").join("\n");

describe("registry publication workflow contracts", () => {
  it("serializes release and recovery for the same repository/tag without cancellation", () => {
    expect(release.concurrency["cancel-in-progress"]).toBe(false);
    expect(recovery.concurrency["cancel-in-progress"]).toBe(false);
    expect(release.concurrency.group.replace("github.ref_name", "inputs.tag")).toBe(
      recovery.concurrency.group,
    );
  });

  it("builds only when first preparation is explicitly allowed, and smokes the saved bytes", () => {
    const prepare = release.jobs["prepare-registry"];
    expect(prepare.needs).toEqual(["release", "release-linux-server"]);
    const restore = prepare.steps.find((step: Step) => step.id === "restore");
    expect(restore?.run).toBe("node scripts/release/package-bundle.mjs restore --allow-missing");
    for (const step of prepare.steps.filter((s: Step) =>
      /npm ci|npm run build|package-bundle.mjs prepare/.test(s.run || ""),
    )) {
      expect(step.if).toBe("steps.restore.outputs.restored != 'true'");
    }
    expect(prepare.steps.at(-1)?.run).toBe("node scripts/release/smoke-bundle.mjs");
    expect(prepare.steps.at(-1)?.if).toBeUndefined();
  });

  it.each(["publish-npm", "publish-github-packages"])(
    "%s consumes the bundle and validates prerequisites",
    (id) => {
      const job = release.jobs[id];
      expect(job.needs).toEqual(["prepare-registry"]);
      expect(commands(job)).not.toMatch(/npm (ci|pack|publish)|npm run build/);
      const runs = job.steps.filter((s: Step) => s.run).map((s: Step) => s.run);
      expect(runs).toEqual([
        "node scripts/release/package-bundle.mjs restore",
        "node scripts/release/package-bundle.mjs verify-evidence",
        "node scripts/release/registry-publication.mjs publish",
      ]);
      expect(job.env.RELEASE_SHA).toBe("${{ github.sha }}");
      expect(job.env.RELEASE_TAG).toBe("${{ github.ref_name }}");
    },
  );

  it("keeps finalization dependent on both platforms and both verified publications", () => {
    const job = release.jobs["publish-github-release"];
    expect(job.needs).toEqual([
      "release",
      "release-linux-server",
      "publish-npm",
      "publish-github-packages",
    ]);
    expect(job.if).toBeUndefined();
    const verified = job.steps.filter(
      (step: Step) => step.run === "node scripts/release/registry-publication.mjs verify",
    );
    expect(verified.map((step: Step) => step.env?.RELEASE_TARGET)).toEqual(["npm", "github"]);
    expect(job.steps.at(-1)?.run).toContain("--draft=false");
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  it("recovers from maintained workflow code and never rebuilds historical packages", () => {
    const job = recovery.jobs.recover;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.steps[0].with?.ref).toBe("${{ github.sha }}");
    expect(job.env.RELEASE_SHA).toBe("${{ inputs.source_sha }}");
    expect(commands(job)).not.toMatch(
      /npm (ci|pack|publish)|npm run build|--allow-missing|package-bundle.mjs prepare/,
    );
    expect(commands(job)).toContain("package-bundle.mjs verify-evidence");
    expect(commands(job)).toContain("RELEASE_DIST_TAG=recovery-");
    const verified = job.steps.filter(
      (step: Step) => step.run === "node scripts/release/registry-publication.mjs verify",
    );
    expect(verified.map((step: Step) => step.env?.RELEASE_TARGET)).toEqual(["npm", "github"]);
    expect(job.steps.at(-1)?.run).toContain("--draft=false");
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  it("runs publication regressions in CI and the release hardening gate", () => {
    expect(commands(read("ci.yml").jobs["registry-publication-tests"])).toContain(
      "node --test scripts/release/*.test.mjs",
    );
    expect(commands(release.jobs["hardening-release-gate"])).toContain(
      "node --test scripts/release/*.test.mjs",
    );
  });
});
