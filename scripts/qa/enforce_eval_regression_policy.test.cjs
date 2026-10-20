const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.join(__dirname, "enforce_eval_regression_policy.cjs");

function runPolicy({ body = "", title = "Improve a local UI flow", evalCase = false, pr = true }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-regression-policy-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () =>
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
  try {
    git("init", "--quiet");
    fs.writeFileSync(path.join(cwd, "sample.txt"), "before\n");
    const caseFile = path.join(cwd, "scripts", "qa", "eval-cases", "regression.json");
    if (evalCase === "deleted" || evalCase === "updated") {
      fs.mkdirSync(path.dirname(caseFile), { recursive: true });
      fs.writeFileSync(caseFile, '{"id":"existing-case"}\n');
    }
    git("add", ".");
    commit();
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(cwd, "sample.txt"), "after\n");
    if (evalCase === "deleted") {
      fs.unlinkSync(caseFile);
    } else if (evalCase) {
      fs.mkdirSync(path.dirname(caseFile), { recursive: true });
      fs.writeFileSync(caseFile, '{"id":"fixture"}\n');
    }
    git("add", ".");
    commit();
    const head = git("rev-parse", "HEAD");
    const event = path.join(cwd, "event.json");
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { title, body, base: { sha: base }, head: { sha: head } } }),
    );
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: pr ? "pull_request" : "push",
        GITHUB_EVENT_PATH: event,
      },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("an unchecked standard incident checkbox does not trigger the incident gate", () => {
  const result = runPolicy({
    body: "## Reliability Regression Policy\n\n- [ ] This PR fixes a production failure/incident.\n- A local walkthrough found this UI defect.",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /production fix detected: no/);
});

test("the unchecked short template marker also stays unselected", () => {
  const result = runPolicy({ body: "- [ ] Production failure fix." });
  assert.equal(result.status, 0, result.output);
});

test("a checked marker still requires an eval case", () => {
  const result = runPolicy({ body: "- [x] This PR fixes a production failure/incident." });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no eval regression case/);
});

test("incident prose remains enforced alongside an unchecked template marker", () => {
  const result = runPolicy({
    body: "- [ ] This PR fixes a production failure/incident.\n\nRepairs a production outage.",
  });
  assert.equal(result.status, 1, result.output);
});

test("a production incident with a changed eval case passes", () => {
  const result = runPolicy({ title: "Repair a production incident", evalCase: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /eval case updated: yes/);
});

test("deleting an eval case does not satisfy the production incident gate", () => {
  const result = runPolicy({ title: "Repair a production incident", evalCase: "deleted" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /eval case updated: no/);
});

test("updating an existing eval case satisfies the production incident gate", () => {
  const result = runPolicy({ title: "Repair a production incident", evalCase: "updated" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /eval case updated: yes/);
});

test("non-PR execution still skips enforcement", () => {
  const result = runPolicy({ title: "Production failure", pr: false });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Not a pull_request event/);
});
