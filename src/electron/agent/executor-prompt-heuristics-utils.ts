export function detectTestRequirement(prompt: string): boolean {
  return /(run|execute)\s+(unit\s+)?tests?|test suite|npm test|pnpm test|yarn test|vitest|jest|pytest|go test|cargo test|mvn test|gradle test|bun test/i.test(
    prompt,
  );
}

export function isTestCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    /(npm|pnpm|yarn)\s+(run\s+)?test(s)?\b/i.test(normalized) ||
    /\bvitest\b/i.test(normalized) ||
    /\bjest\b/i.test(normalized) ||
    /\bpytest\b/i.test(normalized) ||
    /\bgo\s+test\b/i.test(normalized) ||
    /\bcargo\s+test\b/i.test(normalized) ||
    /\bmvn\s+test\b/i.test(normalized) ||
    /\bgradle\s+test\b/i.test(normalized) ||
    /\bbun\s+test\b/i.test(normalized)
  );
}

export function promptRequiresDirectAnswer(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  if (prompt.includes("?")) return true;
  return (
    /\blet me know\b/.test(prompt) ||
    /\btell me\b/.test(prompt) ||
    /\badvise\b/.test(prompt) ||
    /\brecommend\b/.test(prompt) ||
    /\bwhether\b/.test(prompt) ||
    /\bwhich\b.*\b(best|better|choose|option)\b/.test(prompt) ||
    /\bwhat should\b/.test(prompt) ||
    /\bshould i\b/.test(prompt)
  );
}

export function promptRequestsDecision(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  return (
    /\bshould i\b/.test(prompt) ||
    /\bwhether\b/.test(prompt) ||
    /\bwhich\b.*\bchoose\b/.test(prompt) ||
    /\bworth\b/.test(prompt) ||
    /\bwaste of\b/.test(prompt) ||
    /\brecommend\b/.test(prompt) ||
    /\bbest option\b/.test(prompt)
  );
}

export function promptIsWatchSkipRecommendationTask(
  taskTitle: string,
  taskPrompt: string,
): boolean {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  const hasVideoOrTranscriptCue = /\b(video|youtube|podcast|transcript|clip|vlog)\b/.test(prompt);
  const hasReviewWorkCue =
    /\b(transcribe|summarize|review|evaluate|assess|analy[sz]e|watch)\b/.test(prompt);
  const hasDecisionCue =
    /\b(should i|whether|which\b.*\b(choose|better)|worth|waste of|recommend|watch|skip)\b/.test(
      prompt,
    ) || /\brecommend\b/.test(prompt);

  return hasVideoOrTranscriptCue && hasReviewWorkCue && hasDecisionCue;
}
