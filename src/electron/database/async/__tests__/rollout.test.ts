import { afterEach, describe, expect, it } from "vitest";
import {
  DATABASE_WORKER_ROLLOUT,
  configureDatabaseRuntime,
  isDatabaseFlagEnabled,
  isDatabaseWorkerEnabled,
  isSettingsWorkerEnabled,
} from "../runtime";

// Rollout switches (async SQLite migration plan, DB7): explicit environment flags win in
// both directions; an unset flag takes its runtime's default; outside a runtime only
// explicit flags count.

const FLAGS = ["COWORK_DB_WORKER", "COWORK_DB_WORKER_SETTINGS", "COWORK_DB_WORKER_STORAGE"];

describe("database worker rollout switches", () => {
  const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));

  afterEach(() => {
    configureDatabaseRuntime(null);
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  it("follows the runtime's defaults when flags are unset", () => {
    for (const flag of FLAGS) delete process.env[flag];
    configureDatabaseRuntime("desktop");
    expect(isDatabaseWorkerEnabled()).toBe(
      DATABASE_WORKER_ROLLOUT.desktop.COWORK_DB_WORKER === true,
    );
    configureDatabaseRuntime(null);
    expect(isDatabaseWorkerEnabled()).toBe(false);
  });

  it("turns a domain off with an explicit off, whatever the default", () => {
    configureDatabaseRuntime("desktop");
    process.env.COWORK_DB_WORKER = "1";
    process.env.COWORK_DB_WORKER_SETTINGS = "off";
    expect(isDatabaseWorkerEnabled()).toBe(true);
    expect(isSettingsWorkerEnabled()).toBe(false);
  });

  it("turns the whole worker off with COWORK_DB_WORKER=0, domains included", () => {
    configureDatabaseRuntime("daemon");
    process.env.COWORK_DB_WORKER = "0";
    process.env.COWORK_DB_WORKER_SETTINGS = "1";
    expect(isDatabaseWorkerEnabled()).toBe(false);
    expect(isSettingsWorkerEnabled()).toBe(false);
  });

  it("accepts the documented spellings", () => {
    for (const on of ["1", "true", "on", " ON "]) {
      process.env.COWORK_DB_WORKER_STORAGE = on;
      expect(isDatabaseFlagEnabled("COWORK_DB_WORKER_STORAGE")).toBe(true);
    }
    for (const off of ["0", "false", "off"]) {
      process.env.COWORK_DB_WORKER_STORAGE = off;
      expect(isDatabaseFlagEnabled("COWORK_DB_WORKER_STORAGE")).toBe(false);
    }
  });
});
