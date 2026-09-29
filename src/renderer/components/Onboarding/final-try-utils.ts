export const FINAL_TRY_HEADLINE = "Choose a prompt or write your own.";
export const FINAL_TRY_NEXT_STEP =
  "Suggestions fill the prompt. Run in workspace saves your setup, then starts a normal task to follow and review.";

export function selectFinalTrySuggestion(
  prompt: string,
  setInputValue: (value: string) => void,
  clearVoiceError: () => void,
): void {
  setInputValue(prompt);
  clearVoiceError();
}

export function submitFinalTryPrompt(
  input: string,
  queuePrompt: (prompt: string) => void,
  completeOnboarding: () => void,
): boolean {
  const prompt = input.trim();
  if (!prompt) return false;

  queuePrompt(prompt);
  completeOnboarding();
  return true;
}
