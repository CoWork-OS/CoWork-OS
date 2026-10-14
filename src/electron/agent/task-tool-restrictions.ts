/**
 * Tool restrictions a user states in the task itself ("do not use scripting to
 * make the edit"). They become ordinary task tool restrictions, so the tools are
 * hidden from the catalog and denied by the policy pipeline's task_restrictions
 * stage, rather than relying on the model to honor the sentence.
 */

/**
 * Tools that change an application or its documents through app scripting
 * (ExtendScript, AppleScript, JXA). Read-only readbacks such as
 * local_photoshop_read stay available as independent verification.
 */
export const SCRIPTING_MUTATION_TOOLS = [
  "application_operation",
  "local_photoshop_create",
  "local_photoshop_edit",
  "native_application_create",
  "run_applescript",
] as const;

const NEGATION = String.raw`(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|without|no)`;
const SCRIPTING = String.raw`(?:scripting|scripts?|applescript|extendscript|osascript|jxa)`;
// "do not use scripting", "without scripting", "no scripting may make the edit",
// "never use any application scripts", "don't use AppleScript".
const NO_SCRIPTING = new RegExp(
  String.raw`\b${NEGATION}\s+(?:(?:use|using|rely\s+on|fall\s+back\s+to)\s+)?(?:any\s+)?` +
    String.raw`(?:(?:app(?:lication)?|photoshop|native|ui)\s+)?${SCRIPTING}\b`,
  "i",
);

export function taskForbidsScripting(taskText: string): boolean {
  return NO_SCRIPTING.test(String(taskText || ""));
}

/** Restrictions implied by the task's own wording. */
export function promptDerivedToolRestrictions(taskText: string): string[] {
  return taskForbidsScripting(taskText) ? [...SCRIPTING_MUTATION_TOOLS] : [];
}
