export interface TaskMemoryDirectiveSource {
  prompt?: string | null;
  rawPrompt?: string | null;
  userPrompt?: string | null;
}

export function containsNoMemoryDirective(content: unknown): boolean {
  return typeof content === "string" && /<\s*no-memory\s*\/?\s*>/i.test(content);
}

export function taskDisablesMemoryCapture(
  task: TaskMemoryDirectiveSource | null | undefined,
): boolean {
  if (!task) return false;
  return [task.rawPrompt, task.userPrompt, task.prompt].some(containsNoMemoryDirective);
}
