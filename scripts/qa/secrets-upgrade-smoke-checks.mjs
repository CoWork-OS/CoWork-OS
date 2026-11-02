/**
 * The expectations of scripts/qa/secrets-upgrade-smoke.mjs, kept apart from the run so they
 * can be tested without launching an app.
 *
 * Which upgrade a run exercises depends on the baseline it starts from:
 *
 * - "keychain": the baseline seals secrets with the OS keychain directly (0.5.61 and
 *   earlier). This build creates the data key and moves every secret onto it; rolling back
 *   leaves a baseline that cannot read them.
 * - "data-key": the baseline already seals secrets with the app data key (0.5.62 and later).
 *   This build reuses that key and moves nothing; rolling back still reads every secret.
 * - "app": no OS keychain (`--expect=app`); secrets stay sealed with the app key throughout.
 */

/** @typedef {"keychain" | "data-key" | "app"} BaselineMode */
/** @typedef {{ step: string, name: string, ok: boolean }} Check */

/**
 * The mode a run is in, from what the baseline step left in the profile. A data key is the
 * signal (created in the baseline's log, or found in the database or the key file), not how
 * the secrets are sealed: that is asserted separately, so it cannot pass by definition.
 *
 * @param {Record<string, any> | undefined} baselineResult the "1-baseline" step's results
 * @param {"keychain" | "app"} expect
 * @returns {BaselineMode}
 */
export function detectBaselineMode(baselineResult, expect) {
  if (expect === "app") return "app";
  const r = baselineResult ?? {};
  return r.keyCreated || r.dataKeyInDatabase || r.dataKeyFile ? "data-key" : "keychain";
}

/** @param {BaselineMode} mode */
export function describeBaselineMode(mode) {
  switch (mode) {
    case "data-key":
      return "the baseline already seals secrets with the app data key; this build must reuse it";
    case "keychain":
      return "the baseline seals secrets with the OS keychain; this build must move them to the data key";
    case "app":
      return "no OS keychain; secrets stay sealed with the app key";
    default:
      throw new Error(`Unknown baseline mode: ${mode}`);
  }
}

/**
 * Every expectation, by step, for the results of one run.
 *
 * @param {Record<string, Record<string, any>>} results per-step results
 * @param {BaselineMode} mode
 * @returns {Check[]}
 */
export function secretsUpgradeChecks(results, mode) {
  if (!["keychain", "data-key", "app"].includes(mode)) {
    throw new Error(`Unknown baseline mode: ${mode}`);
  }
  const expectKeychain = mode !== "app";
  /** @type {Check[]} */
  const checks = [];
  const check = (step, name, ok) => checks.push({ step, name, ok: !!ok });
  const r = results;
  check("1-baseline", "saved and read the API key", r["1-baseline"].apiKeyRead);
  if (mode === "data-key") {
    check(
      "1-baseline",
      "sealed it with the app data key",
      r["1-baseline"].llmSealedBy === "data-key",
    );
    check(
      "1-baseline",
      "data key in the database and the key file",
      r["1-baseline"].dataKeyInDatabase && r["1-baseline"].dataKeyFile,
    );
  } else {
    check(
      "1-baseline",
      expectKeychain ? "sealed it with the OS keychain" : "sealed it with the app key",
      r["1-baseline"].llmSealedBy === (expectKeychain ? "keychain" : "app"),
    );
  }
  for (const step of ["2-current", "3-current-again", "5-key-file-lost", "7-upgrade-again"]) {
    check(step, "read the API key", r[step].apiKeyRead);
    check(step, "log captured", r[step].logCaptured);
    check(step, "no safeStorage deprecation warning", r[step].deprecationWarnings === 0);
    check(step, "no secret read through the synchronous keychain call", r[step].legacyReads === 0);
    if (expectKeychain) {
      check(
        step,
        "every secret sealed with the data key",
        r[step].sealing?.["data-key"] === r[step].secrets,
      );
      check(
        step,
        "keychain canary sealed with the data key",
        r[step].canarySealedBy === "data-key",
      );
      check(
        step,
        "data key in the database and the key file",
        r[step].dataKeyInDatabase && r[step].dataKeyFile,
      );
    } else {
      check(step, "no data key created", !r[step].dataKeyInDatabase && !r[step].dataKeyFile);
      check(
        step,
        "secrets still sealed with the app key",
        r[step].sealing?.app === r[step].secrets,
      );
    }
  }
  if (mode === "keychain") {
    check("2-current", "created the data key", r["2-current"].keyCreated);
    check("2-current", "moved the secrets onto it", r["2-current"].movedToDataKey > 0);
    check("3-current-again", "nothing left to move", r["3-current-again"].movedToDataKey === 0);
    check(
      "5-key-file-lost",
      "key file restored from the database",
      r["5-key-file-lost"].keyFileRestored,
    );
    check("6-rollback", "baseline cannot read the moved secret", !r["6-rollback"].apiKeyRead);
  } else if (mode === "data-key") {
    // The same sealed key the baseline stored, and no new one: a second key would orphan
    // every secret the baseline sealed.
    check(
      "2-current",
      "reused the existing data key",
      !r["2-current"].keyCreated &&
        !!r["1-baseline"].dataKeyHash &&
        r["2-current"].dataKeyHash === r["1-baseline"].dataKeyHash,
    );
    check("2-current", "nothing moved", r["2-current"].movedToDataKey === 0);
    check("3-current-again", "nothing to move", r["3-current-again"].movedToDataKey === 0);
    check(
      "5-key-file-lost",
      "key file restored from the database",
      r["5-key-file-lost"].keyFileRestored,
    );
    check("6-rollback", "baseline still reads the secrets", r["6-rollback"].apiKeyRead);
  }
  check("6-rollback", "secrets left as they were", r["6-rollback"].secretsUntouched);
  check("6-rollback", "nothing archived as unreadable", r["6-rollback"].unreadableBackups === 0);
  if (r["4-cli"]) {
    check("4-cli", "sent the right key to the provider", r["4-cli"].sentRightKey);
    check("4-cli", "no safeStorage deprecation warning", r["4-cli"].deprecationWarnings === 0);
  }
  for (const [step, result] of Object.entries(results)) {
    if (result.error) check(step, `ran without error: ${result.error.split("\n")[0]}`, false);
  }
  return checks;
}
