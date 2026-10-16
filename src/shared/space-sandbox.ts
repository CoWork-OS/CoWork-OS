/** Shared validation for explicit, portable SPACE file selections. */
export function isSpaceRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\\:<>"|?*\x00-\x1f\x7f]/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          !/^(?:\.git|\.cowork|\.ssh|\.aws|\.azure|\.config|\.gnupg|\.env(?:\..*)?|\.npmrc|\.netrc)$/i.test(
            part,
          ),
      )
  );
}

export function describeSpaceExecution(config: {
  inputPaths?: string[];
  outputPaths?: string[];
}): string {
  return (
    "Runs in a fresh, offline SPACE Linux microVM at /workspace on every invocation. " +
    "Only these selected local inputs are copied: " +
    JSON.stringify(config.inputPaths || []) +
    ". " +
    "Only these remote outputs are published as new local workspace files after successful completion: " +
    JSON.stringify(config.outputPaths || []) +
    ". " +
    "Create those outputs in this single invocation. Host file tools stay local. No package downloads, host absolute paths, background processes, interactive input, or persistent shell state. Never automatically replay a command whose outcome is unknown."
  );
}

/** Published template names accepted by the native SPACE API. */
export function isSpaceTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 384 &&
    /^[A-Za-z0-9._-]+(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})?$/.test(value)
  );
}
