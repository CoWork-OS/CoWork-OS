export const FINAL_TRY_HEADLINE = "Choose a prompt or write your own.";
export const FINAL_TRY_NEXT_STEP =
  "Start task saves your setup, connects any apps you need, then starts a normal task to follow and review. You can personalize CoWork later.";

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
