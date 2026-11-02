import assert from "node:assert/strict";
import test from "node:test";
import {
  describeBaselineMode,
  detectBaselineMode,
  secretsUpgradeChecks,
} from "./secrets-upgrade-smoke-checks.mjs";

// Step results as the smoke recorded them on macOS: from 0.5.61 (run 40578885223, which
// passed) and from 0.5.62 (run 41347492224, which failed the keychain expectations). The
// data key hash is added here; those runs predate it.
const step = (overrides) => ({
  apiKeyRead: true,
  logCaptured: true,
  deprecationWarnings: 0,
  movedToDataKey: 0,
  legacyReads: 0,
  keyCreated: false,
  keyUnreadable: false,
  secrets: 3,
  sealing: { "data-key": 3 },
  llmSealedBy: "data-key",
  canarySealedBy: "data-key",
  dataKeyInDatabase: true,
  dataKeyHash: "3f1c9a0d5b7e2468",
  dataKeyFile: true,
  localStateInProfile: true,
  unreadableBackups: 0,
  ...overrides,
});

function keychainBaselineRun() {
  return {
    "1-baseline": step({
      sealing: { keychain: 3 },
      llmSealedBy: "keychain",
      canarySealedBy: "keychain",
      dataKeyInDatabase: false,
      dataKeyHash: null,
      dataKeyFile: false,
    }),
    "2-current": step({ movedToDataKey: 1, keyCreated: true }),
    "3-current-again": step({}),
    "5-key-file-lost": step({ keyFileRestored: true }),
    "6-rollback": step({ apiKeyRead: false, secretsUntouched: true }),
    "7-upgrade-again": step({}),
  };
}

function dataKeyBaselineRun() {
  return {
    "1-baseline": step({ keyCreated: true }),
    "2-current": step({}),
    "3-current-again": step({}),
    "5-key-file-lost": step({ keyFileRestored: true }),
    "6-rollback": step({ secretsUntouched: true }),
    "7-upgrade-again": step({}),
  };
}

function appKeyRun() {
  const app = (overrides) =>
    step({
      sealing: { app: 3 },
      llmSealedBy: "app",
      canarySealedBy: null,
      dataKeyInDatabase: false,
      dataKeyHash: null,
      dataKeyFile: false,
      ...overrides,
    });
  return {
    "1-baseline": app({}),
    "2-current": app({}),
    "3-current-again": app({}),
    "5-key-file-lost": app({ keyFileRestored: false }),
    "6-rollback": app({ secretsUntouched: true }),
    "7-upgrade-again": app({}),
  };
}

const failed = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.step}: ${c.name}`);
const names = (checks) => checks.map((c) => `${c.step}: ${c.name}`);

test("a baseline without a data key is the keychain upgrade", () => {
  assert.equal(detectBaselineMode(keychainBaselineRun()["1-baseline"], "keychain"), "keychain");
});

test("a baseline that created or stored a data key is the data-key upgrade", () => {
  assert.equal(detectBaselineMode(dataKeyBaselineRun()["1-baseline"], "keychain"), "data-key");
  const keychain = keychainBaselineRun()["1-baseline"];
  assert.equal(detectBaselineMode({ ...keychain, keyCreated: true }, "keychain"), "data-key");
  assert.equal(detectBaselineMode({ ...keychain, dataKeyFile: true }, "keychain"), "data-key");
  assert.equal(
    detectBaselineMode({ ...keychain, dataKeyInDatabase: true }, "keychain"),
    "data-key",
  );
});

test("the mode comes from the data key, not from how the secrets are sealed", () => {
  // Sealed with the data key but no key anywhere: the keychain expectations apply and fail.
  const baseline = { ...keychainBaselineRun()["1-baseline"], llmSealedBy: "data-key" };
  assert.equal(detectBaselineMode(baseline, "keychain"), "keychain");
});

test("without an OS keychain the mode is always the app key", () => {
  assert.equal(detectBaselineMode(appKeyRun()["1-baseline"], "app"), "app");
  assert.equal(detectBaselineMode(dataKeyBaselineRun()["1-baseline"], "app"), "app");
});

test("a baseline that never ran is the keychain upgrade, which then fails", () => {
  assert.equal(detectBaselineMode(undefined, "keychain"), "keychain");
  assert.equal(detectBaselineMode({ error: "could not launch" }, "keychain"), "keychain");
});

test("every mode has a description; an unknown one is refused", () => {
  for (const mode of ["keychain", "data-key", "app"]) {
    assert.match(describeBaselineMode(mode), /\w/);
  }
  assert.throws(() => describeBaselineMode("other"), /Unknown baseline mode/);
  assert.throws(() => secretsUpgradeChecks(keychainBaselineRun(), "other"), /Unknown/);
});

test("the keychain upgrade keeps its expectations unchanged", () => {
  const checks = secretsUpgradeChecks(keychainBaselineRun(), "keychain");
  assert.deepEqual(failed(checks), []);
  const perStep = (s) => [
    `${s}: read the API key`,
    `${s}: log captured`,
    `${s}: no safeStorage deprecation warning`,
    `${s}: no secret read through the synchronous keychain call`,
    `${s}: every secret sealed with the data key`,
    `${s}: keychain canary sealed with the data key`,
    `${s}: data key in the database and the key file`,
  ];
  assert.deepEqual(names(checks), [
    "1-baseline: saved and read the API key",
    "1-baseline: sealed it with the OS keychain",
    ...perStep("2-current"),
    ...perStep("3-current-again"),
    ...perStep("5-key-file-lost"),
    ...perStep("7-upgrade-again"),
    "2-current: created the data key",
    "2-current: moved the secrets onto it",
    "3-current-again: nothing left to move",
    "5-key-file-lost: key file restored from the database",
    "6-rollback: baseline cannot read the moved secret",
    "6-rollback: secrets left as they were",
    "6-rollback: nothing archived as unreadable",
  ]);
});

test("a data-key baseline judged as a keychain one fails as the 0.5.62 run did", () => {
  const checks = secretsUpgradeChecks(dataKeyBaselineRun(), "keychain");
  assert.deepEqual(failed(checks), [
    "1-baseline: sealed it with the OS keychain",
    "2-current: created the data key",
    "2-current: moved the secrets onto it",
    "6-rollback: baseline cannot read the moved secret",
  ]);
  assert.equal(checks.length, 37);
});

test("a data-key baseline passes the data-key expectations", () => {
  const checks = secretsUpgradeChecks(dataKeyBaselineRun(), "data-key");
  assert.deepEqual(failed(checks), []);
  const listed = names(checks);
  for (const name of [
    "1-baseline: sealed it with the app data key",
    "1-baseline: data key in the database and the key file",
    "2-current: reused the existing data key",
    "2-current: nothing moved",
    "2-current: every secret sealed with the data key",
    "3-current-again: nothing to move",
    "5-key-file-lost: key file restored from the database",
    "6-rollback: baseline still reads the secrets",
    "6-rollback: secrets left as they were",
    "6-rollback: nothing archived as unreadable",
  ]) {
    assert.ok(listed.includes(name), `missing check: ${name}`);
  }
  assert.ok(!listed.some((name) => /OS keychain|cannot read|created the data key/.test(name)));
});

test("the data-key expectations catch a new key, moved secrets and a failed rollback", () => {
  const cases = [
    [
      (r) => (r["1-baseline"].llmSealedBy = "keychain"),
      "1-baseline: sealed it with the app data key",
    ],
    [
      (r) => (r["1-baseline"].dataKeyFile = false),
      "1-baseline: data key in the database and the key file",
    ],
    [(r) => (r["2-current"].keyCreated = true), "2-current: reused the existing data key"],
    [
      (r) => (r["2-current"].dataKeyHash = "0000000000000000"),
      "2-current: reused the existing data key",
    ],
    [(r) => (r["1-baseline"].dataKeyHash = null), "2-current: reused the existing data key"],
    [(r) => (r["2-current"].movedToDataKey = 2), "2-current: nothing moved"],
    [(r) => (r["3-current-again"].movedToDataKey = 1), "3-current-again: nothing to move"],
    [
      (r) => (r["5-key-file-lost"].keyFileRestored = false),
      "5-key-file-lost: key file restored from the database",
    ],
    [(r) => (r["6-rollback"].apiKeyRead = false), "6-rollback: baseline still reads the secrets"],
    [(r) => (r["6-rollback"].unreadableBackups = 1), "6-rollback: nothing archived as unreadable"],
    [(r) => (r["6-rollback"].secretsUntouched = false), "6-rollback: secrets left as they were"],
    [
      (r) => (r["7-upgrade-again"].sealing = { "data-key": 2, keychain: 1 }),
      "7-upgrade-again: every secret sealed with the data key",
    ],
  ];
  for (const [breakRun, expected] of cases) {
    const run = dataKeyBaselineRun();
    breakRun(run);
    assert.deepEqual(failed(secretsUpgradeChecks(run, "data-key")), [expected]);
  }
});

test("the app-key run keeps its expectations unchanged", () => {
  const checks = secretsUpgradeChecks(appKeyRun(), "app");
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.length, 28);
  assert.ok(names(checks).includes("1-baseline: sealed it with the app key"));
});

test("a step error and the CLI step are checked in every mode", () => {
  for (const [mode, run] of [
    ["keychain", keychainBaselineRun()],
    ["data-key", dataKeyBaselineRun()],
  ]) {
    run["4-cli"] = { sentRightKey: false, deprecationWarnings: 0 };
    run["3-current-again"].error = "3-current-again: the main window never opened\n    at stack";
    assert.deepEqual(failed(secretsUpgradeChecks(run, mode)), [
      "4-cli: sent the right key to the provider",
      "3-current-again: ran without error: 3-current-again: the main window never opened",
    ]);
  }
});
