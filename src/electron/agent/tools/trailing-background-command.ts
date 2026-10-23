/** Convert only a single, unambiguous POSIX command. Complex shell programs stay unchanged. */
export function trailingBackgroundCommand(command: unknown): string | undefined {
  if (typeof command !== "string" || !/\s&\s*$/.test(command)) return undefined;
  const body = command.trimEnd().slice(0, -1).trimEnd();
  // No substitutions, redirects, chaining, comments, escapes, or multiline programs.
  if (!body || /[;&|`<>#$\\\n\r]/.test(body)) return undefined;
  let quote = "";
  for (const char of body) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') quote = char;
  }
  if (quote) return undefined;
  const executable = body.trimStart().split(/\s/, 1)[0];
  if (!/^[a-zA-Z0-9_./~-]+$/.test(executable)) return undefined;
  const base = executable.split("/").pop();
  if (
    /^(?:nohup|disown|bg|fg|exec|eval|env|sudo|doas|command|builtin|sh|bash|zsh|fish|dash|ksh)$/.test(
      base ?? "",
    )
  )
    return undefined;
  return body;
}
