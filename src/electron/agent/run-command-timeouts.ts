/**
 * Time limits for one foreground run_command call, shared by the executor
 * (which budgets the tool call) and the shell tools (which kill the command),
 * so the two cannot drift apart.
 */

/** Kill timeout when the call sets none and the command is not a build or test. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/** Inferred timeout for installs, builds and test runs that set none. */
export const RUN_COMMAND_HEAVY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Longest timeout a call may request. Release builds, full test suites and
 * model downloads routinely take 10-30 minutes; deep-work steps last 45. The
 * executor still clamps every request to the current step's budget, so outside
 * deep work the effective ceiling is just under the 15-minute step timeout.
 */
export const RUN_COMMAND_MAX_TIMEOUT_MS = 30 * 60 * 1000;
