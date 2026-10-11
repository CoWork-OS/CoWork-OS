export interface TaskMemoryDirectiveSource {
  prompt?: string | null;
  rawPrompt?: string | null;
  userPrompt?: string | null;
  parentTaskId?: string | null;
  agentType?: string | null;
  agentConfig?: { retainMemory?: boolean } | null;
}

export function containsNoMemoryDirective(content: unknown): boolean {
  return typeof content === "string" && /<\s*no-memory\s*\/?\s*>/i.test(content);
}

export function taskDisablesMemoryCapture(
  task: TaskMemoryDirectiveSource | null | undefined,
): boolean {
  if (!task) return false;
  const retainMemory =
    task.agentConfig?.retainMemory ?? !(task.parentTaskId || task.agentType === "sub");
  if (!retainMemory) return true;
  return [task.rawPrompt, task.userPrompt, task.prompt].some(containsNoMemoryDirective);
}
