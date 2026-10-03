/**
 * Shared harness of the memory eval suites (`*.eval.test.ts`, docs/harness-eval-battery.md).
 * Each suite is its own test file, so every suite gets fresh service singletons (the
 * memory services keep process-wide state bound to one profile database).
 *
 * `COWORK_MEMORY_EVALS_STRICT=1` (set by `npm run qa:memory-evals`) turns a missing native
 * SQLite binding into a failure instead of a skipped suite.
 */
import { describe } from "vitest";
import type { MemoryEvalEnv } from "./memory-eval-env";

export const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

if (process.env.COWORK_MEMORY_EVALS_STRICT === "1" && !nativeSqliteAvailable) {
  throw new Error(
    "Memory evals need the native better-sqlite3 binding for this Node version (npm rebuild better-sqlite3).",
  );
}

export const describeEval = nativeSqliteAvailable ? describe : describe.skip;

/** The environment module, imported after the suite's mocks are in place. */
export const envModule = () => import("./memory-eval-env");

/** Fixture keys of recall refs, best first (unknown refs as `?<ref>`). */
export function keysOf(env: MemoryEvalEnv, refs: string[]): string[] {
  return refs.map((ref) => env.keysByRef.get(ref) ?? `?${ref}`);
}
