/**
 * Content prefixes of memories that PlaybookService itself generates. Matched anchored at
 * the start so arbitrary user text that merely mentions "Playbook" is never matched.
 *
 * Generated Playbook rows stay in memory for history and explicit inspection, but are
 * excluded from generic prompt recall: typed Playbook lookup supplies evidence-backed
 * success context instead, so legacy reinforcement claims cannot re-enter prompts.
 */
const GENERATED_PLAYBOOK_PREFIX =
  /^\s*\[PLAYBOOK\] (?:Task succeeded:|Task failed:|Reinforced pattern:|Inbox pattern:)/;

export function isGeneratedPlaybookContent(content: string | undefined | null): boolean {
  return typeof content === "string" && GENERATED_PLAYBOOK_PREFIX.test(content);
}
