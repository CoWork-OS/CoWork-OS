/** Classify source requirements without confusing a phone's search UI with web research. */
export function needsTaskWebEvidence(title: string, taskPrompt: string): boolean {
  const prompt = `${title}\n${taskPrompt}`.toLowerCase();
  const strongResearchSignal =
    /\b(?:news|latest|today|trending|breaking|reddit|headline|current events)\b/;
  const searchSignal = /\bsearch\b/;
  const explicitWebSearch =
    /\b(?:web_search|web_fetch)\b|\bsearch\s+(?:the\s+)?(?:web|internet|online|google|bing)\b|\bbrowse\s+the\s+web\b/.test(
      prompt,
    );
  if (!strongResearchSignal.test(prompt) && !searchSignal.test(prompt) && !explicitWebSearch)
    return false;
  const buildSignals = [
    "create an app",
    "build an app",
    "make an app",
    "write an app",
    "create a tool",
    "build a tool",
    "create a website",
    "build a website",
    "implement",
    "develop an app",
    "develop a tool",
  ];
  if (buildSignals.some((signal) => prompt.includes(signal))) return false;
  const localPhoneWorkflow =
    /\b(?:android|emulator-\d+)\b/.test(prompt) &&
    /\b(?:tap|type_text|screenshot|application_operation|phone\.android\.action)\b/.test(prompt);
  if (localPhoneWorkflow && !strongResearchSignal.test(prompt) && !explicitWebSearch) return false;
  return true;
}
