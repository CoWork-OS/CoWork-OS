/**
 * Environment defaults that keep agent-run commands from waiting for a human
 * who is not there: no terminal credential prompts, editors or pagers, and no
 * installer questions. They only fill variables that are not already set, so
 * an explicit or inherited value wins.
 *
 * CI is deliberately absent: tools change behavior under CI (Create React App,
 * for one, turns lint warnings into build errors).
 */
export const NON_INTERACTIVE_COMMAND_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  PIP_NO_INPUT: "1",
  DEBIAN_FRONTEND: "noninteractive",
});

/** Fill the non-interactive defaults into `env` where unset; returns `env`. */
export function applyNonInteractiveEnvDefaults<T extends Record<string, string | undefined>>(
  env: T,
): T {
  const target = env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(NON_INTERACTIVE_COMMAND_ENV)) {
    if (target[key] === undefined) target[key] = value;
  }
  return env;
}
