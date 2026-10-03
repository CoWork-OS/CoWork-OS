/**
 * Finds test commands that failed and were never shown to pass, when the task
 * nevertheless ended on a passing test run of some other command. Example: the
 * project's `npm test` fails, the agent then runs `node --test test/a.test.js`,
 * which passes, and reports that the tests pass. The completion check uses this
 * to tell the user the configured command is still failing.
 */

export interface RecordedVerificationRun {
  kind: "test" | "build";
  command: string;
  succeeded: boolean;
  seq: number;
}

export interface UnresolvedTestCommandFailures {
  /** Failed test commands with no later run that covers them, oldest first. */
  failingCommands: string[];
  /** The latest passing test command. */
  passingCommand: string;
}

// Commands that run a project's whole test suite, so a pass covers any narrower
// failing test command.
const FULL_SUITE_PATTERNS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)(?: run)? test$/,
  /^(?:(?:npx|bunx|pnpm exec|yarn) )?(?:vitest|jest|mocha)(?: run)?$/,
  /^(?:python3? -m )?pytest$/,
  /^go test \.\/\.\.\.$/,
  /^cargo test$/,
];

/** The test-running parts of a shell command line, normalized. */
function testSegments(command: string, isTestCommand: (segment: string) => boolean): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) =>
      segment
        .replace(/\s+/g, " ")
        .trim()
        // Leading environment assignments (CI=1 npm test) do not change the suite.
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, ""),
    )
    .filter((segment) => segment.length > 0 && isTestCommand(segment));
}

/**
 * Whether a passing run of `passing` shows that `failing` would pass too: the
 * same command, the same command with only extra flags, a broader command
 * (`vitest run` covers `vitest run src/a.test.ts`), or the whole suite.
 */
function covers(passing: string, failing: string): boolean {
  if (passing === failing) return true;
  if (FULL_SUITE_PATTERNS.some((pattern) => pattern.test(passing))) return true;
  if (failing.startsWith(`${passing} `)) return true;
  if (passing.startsWith(`${failing} `)) {
    return passing
      .slice(failing.length + 1)
      .split(" ")
      .every((token) => token.startsWith("-"));
  }
  return false;
}

export function findUnresolvedTestCommandFailures(
  runs: readonly RecordedVerificationRun[],
  isTestCommand: (segment: string) => boolean,
): UnresolvedTestCommandFailures | null {
  const failing = new Map<string, number>();
  let passingCommand = "";
  let passingSeq = -1;
  for (const run of [...runs].sort((a, b) => a.seq - b.seq)) {
    if (run.kind !== "test") continue;
    const segments = testSegments(run.command, isTestCommand);
    if (segments.length === 0) continue;
    if (run.succeeded) {
      for (const failed of [...failing.keys()]) {
        if (segments.some((segment) => covers(segment, failed))) failing.delete(failed);
      }
      passingCommand = segments.join(" && ");
      passingSeq = run.seq;
    } else {
      for (const segment of segments) {
        failing.delete(segment);
        failing.set(segment, run.seq);
      }
    }
  }
  // Without a later pass the agent cannot be claiming the tests pass; a red
  // final run is handled by the test-run requirement and the step outcome.
  const unresolved = [...failing.entries()]
    .filter(([, seq]) => seq < passingSeq)
    .map(([command]) => command);
  if (unresolved.length === 0) return null;
  return { failingCommands: unresolved, passingCommand };
}
