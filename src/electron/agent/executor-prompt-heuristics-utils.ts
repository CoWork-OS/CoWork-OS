const TEST_RUN_VERB = String.raw`(?:run|re-?run|running|execute|executing|perform)`;
const TEST_NOUN = String.raw`(?:tests?|test\s+suites?|specs?)`;
// A verb inside a relative or purpose clause describes an artifact's behavior
// ("a workflow that will run pytest", "a CI job to run the tests"), not a
// request to run tests now.
const DESCRIBED_RUN_CONTEXT =
  /(?:\b(?:that|which)\s+(?:[\w-]+\s+){0,2}|\b(?:workflows?|jobs?|pipelines?|hooks?|actions?|scripts?|targets?|cron|ci)\b[^.;!?\n]{0,30}\bto\s+)$/;
const TEST_CONTEXT = /\b(?:tests?|specs?|suites?|pass(?:es|ing)?|green)\b/;

function stripNegatedTestRequests(prompt: string): string {
  const negatedTestRequestPatterns = [
    /\b(?:do not|don't|dont|never|must not|should not|avoid|no need to|don't need to)\s+(?:run|execute|perform|running|executing)\s+(?:(?:any|the)\s+)?(?:(?:unit|integration|end-to-end)\s+)?(?:tests?|test suite)\b/gi,
    /\b(?:do not|don't|dont|never|must not|should not)\s+(?:run|execute)\s+(?:(?:any|the)\s+)?(?:commands?|shell(?:\s+commands?)?)(?:[^.!?;]{0,100}?\b(?:or|and)\s+(?:(?:run|execute)\s+)?(?:(?:any|the)\s+)?(?:(?:unit|integration|end-to-end)\s+)?(?:tests?|test suite)\b)/gi,
  ];
  return negatedTestRequestPatterns.reduce(
    (remaining, pattern) => remaining.replace(pattern, " "),
    prompt,
  );
}

function sentenceAround(text: string, index: number, length: number): string {
  const before = text.slice(0, index);
  const start = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("\n"),
    before.lastIndexOf(";"),
  );
  const tail = text.slice(index + length);
  const endMatch = /[.;\n]/.exec(tail);
  return text.slice(start + 1, endMatch ? index + length + endMatch.index : text.length);
}

/**
 * Commands named in backticks that the prompt asks to run as its test step
 * ("run `./scripts/ci.sh` and make sure the tests pass"). Running exactly
 * that command satisfies the test-run requirement even when isTestCommand
 * does not recognize the runner.
 */
export function extractNamedTestCommands(prompt: string): string[] {
  const text = stripNegatedTestRequests(String(prompt || ""));
  const commands = new Set<string>();
  const pattern = new RegExp(String.raw`\b${TEST_RUN_VERB}\s+\x60([^\x60\n]{2,200})\x60`, "gi");
  for (const match of text.matchAll(pattern)) {
    const command = match[1].replace(/\s+/g, " ").trim();
    const index = match.index ?? 0;
    if (DESCRIBED_RUN_CONTEXT.test(text.slice(Math.max(0, index - 60), index).toLowerCase())) {
      continue;
    }
    const sentence = sentenceAround(text, index, match[0].length).toLowerCase();
    const sentenceOutsideCommand = sentence.replace(/\x60[^\x60]*\x60/g, " ");
    if (isTestCommand(command) || TEST_CONTEXT.test(sentenceOutsideCommand)) {
      commands.add(command);
    }
  }
  return Array.from(commands);
}

/**
 * Detect an imperative request to run tests or to leave them passing. Merely
 * mentioning a runner ("compare jest and vitest", "a workflow that runs
 * pytest") is not a request to run the suite.
 */
export function detectTestRequirement(prompt: string): boolean {
  const text = stripNegatedTestRequests(String(prompt || "")).toLowerCase();

  const runVerbPattern = new RegExp(
    String.raw`\b${TEST_RUN_VERB}\s+|\b(?:verify|validate|check|confirm|test)\b[^.;!?\n]{0,30}?\b(?:with|using|via|by\s+running)\s+`,
    "g",
  );
  for (const match of text.matchAll(runVerbPattern)) {
    const index = match.index ?? 0;
    if (DESCRIBED_RUN_CONTEXT.test(text.slice(Math.max(0, index - 60), index))) continue;
    const rest = text.slice(index + match[0].length, index + match[0].length + 120);
    const object = rest.split(/[.;!?\n]|,\s+(?:and|then|but)\b/)[0] || "";
    if (new RegExp(String.raw`^(?:[\w./-]+\s+){0,3}?${TEST_NOUN}\b`).test(object)) return true;
    if (isTestCommand(object.replace(/\x60/g, " "))) return true;
  }
  if (extractNamedTestCommands(text).length > 0) return true;

  const plainText = text.replace(/\x60/g, "");
  return (
    new RegExp(
      String.raw`\b(?:make\s+sure|ensure|verify|confirm|check)\s+(?:that\s+)?(?:[\w-]+\s+){0,3}?${TEST_NOUN}\s+(?:still\s+|now\s+|all\s+)?(?:pass(?:es)?|succeeds?|(?:is|are)\s+(?:green|passing))\b`,
    ).test(plainText) ||
    new RegExp(
      String.raw`\b${TEST_NOUN}\s+(?:should|must|need\s+to|have\s+to)\s+(?:still\s+)?pass\b`,
    ).test(plainText) ||
    new RegExp(
      String.raw`\b(?:make|get|keep)\s+(?:[\w-]+\s+){0,3}?${TEST_NOUN}\s+(?:to\s+)?pass(?:ing)?\b`,
    ).test(plainText) ||
    new RegExp(String.raw`\buntil\s+(?:[\w-]+\s+){0,3}?${TEST_NOUN}\s+pass(?:es)?\b`).test(
      plainText,
    )
  );
}

const TEST_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\b(?:\s+(?:-{1,2}[\w-]+(?:=\S+)?|(?:workspace|--filter|-F|--prefix|-C|--dir)\s+\S+|run|run-script|-r|--recursive))*\s+(?:t|tests?(?:[:-][\w:-]+)?)(?=\s|$)/i,
  // Runner names count at command position only, so "cat jest.config.js" or
  // "pip install pytest-xdist" is not mistaken for a test run.
  /(?:^|[\s/;&|(])(?:vitest|jest|pytest|rspec|phpunit|ctest|tox|nox|mocha)(?=[\s@]|$)/i,
  /\bpython3?\s+-m\s+(?:pytest|unittest|nose2?)\b/i,
  /\b(?:go|cargo|dotnet|swift|deno|mix|flutter|dart|bazel(?:isk)?)\s+test\b/i,
  /\bcargo\s+nextest\b/i,
  /\bmvnw?\b[^|;&\n]*\b(?:test|verify)\b/i,
  /\bgradlew?\b[^|;&\n]*\b(?:test|check)\b/i,
  /\bmake\s+(?:-\S+\s+)*(?:test|tests|check)\b/i,
  /\b(?:playwright|cypress)\s+(?:test|run)\b/i,
  /\bnode\s+(?:[^|;&\n]*\s)?--test\b/i,
  /\bturbo\s+(?:run\s+)?test\b/i,
  /\bxcodebuild\b[^|;&\n]*\btest\b/i,
];

export function isTestCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
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
