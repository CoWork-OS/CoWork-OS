export interface NaturalLlmWikiPromptRoutingResult {
  matched: boolean;
  objective?: string;
  mode?: "auto" | "init" | "ingest" | "query" | "lint" | "refresh";
  obsidian?: "auto" | "on" | "off";
  args?: string;
}

function quoteSkillSlashValue(value: string): string {
  const text = String(value ?? "");
  if (!text.length) return '""';
  if (!/[\s"'`\\]|^--?/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizePrompt(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupObjective(value: string): string {
  return String(value || "")
    .replace(/^[`"'([{<\s]+/, "")
    .replace(/[`"')\]}>.,!?;:\s]+$/, "")
    .replace(/\s+(?:in|inside|within)\s+(?:this|the)\s+workspace(?:\s+please)?$/i, "")
    .replace(
      /\s+(?:and|while)\s+(?:keep|preserve|create|cross[- ]link|maintain|update|refresh)\b.*$/i,
      "",
    )
    .replace(/\s+with\s+(?:raw|linked|obsidian)\b.*$/i, "")
    .trim();
}

function inferMode(prompt: string, objective: string): NaturalLlmWikiPromptRoutingResult["mode"] {
  if (/\b(?:lint|audit|check|validate|health(?: check)?|inspect)\b/i.test(prompt)) {
    return "lint";
  }
  if (/\b(?:refresh|recheck|re-check|update against fresher evidence)\b/i.test(prompt)) {
    return "refresh";
  }
  const mentionsVault = /\b(?:research )?vault\b/i.test(prompt);
  if (
    /\b(?:query|answer from)\b/i.test(prompt) ||
    (mentionsVault && /\banswer\b/i.test(prompt)) ||
    (mentionsVault && /\blook up\b/i.test(prompt))
  ) {
    return "query";
  }
  if (!objective && /\b(?:init|initialize|bootstrap|scaffold|seed|set up|setup)\b/i.test(prompt)) {
    return "init";
  }
  if (/\b(?:ingest|gather|collect|crawl|study|survey)\b/i.test(prompt)) {
    return "ingest";
  }
  return "auto";
}

function inferObsidian(prompt: string): NaturalLlmWikiPromptRoutingResult["obsidian"] {
  if (/\bnot\s+obsidian\b|\bwithout\s+obsidian\b/i.test(prompt)) {
    return "off";
  }
  if (/\bobsidian\b/i.test(prompt)) {
    return "on";
  }
  return "auto";
}

export function parseNaturalLlmWikiPrompt(value: string): NaturalLlmWikiPromptRoutingResult {
  const prompt = normalizePrompt(value);
  if (!prompt || prompt.startsWith("/")) {
    return { matched: false };
  }

  const lower = prompt.toLowerCase();
  if (
    /\b(?:one-off|one off|single)\s+(?:summary|answer|report)\b/i.test(prompt) ||
    /\bdo not save anything durable\b/i.test(prompt) ||
    /\bno need for (?:a )?(?:persistent )?(?:vault|wiki|knowledge base)\b/i.test(prompt)
  ) {
    return { matched: false };
  }

  const isDirectSkillPrompt = /\buse\s+(?:the\s+)?llm[- ]wiki\b/i.test(prompt);
  const hasVaultPhrase =
    /\bllm[- ]wiki\b/i.test(prompt) ||
    /\bresearch vault\b/i.test(prompt) ||
    /\bobsidian(?:-friendly)?(?: research)? vault\b/i.test(prompt) ||
    /\bpersistent markdown knowledge base\b/i.test(prompt);
  const hasLaunchIntent =
    /^(?:please\s+)?(?:help me\s+)?(?:build|create|make|start|spin up|set up|setup|maintain|refresh|update|lint|audit|check|query|use|answer)\b/i.test(
      lower,
    ) || /^(?:please\s+)?i\s+(?:want|need)(?:\s+you)?\s+to\b/i.test(lower);

  if (!isDirectSkillPrompt && !(hasVaultPhrase && hasLaunchIntent)) {
    return { matched: false };
  }

  const wantsTopicPrompt =
    /\b(?:topic|research area|subject|question)\s+i\s+(?:give|provide|share|ask)\b/i.test(prompt) ||
    /\bif\s+i\s+(?:have not|haven't)\s+given\b.*\b(?:topic|subject|research area|question)\b/i.test(
      prompt,
    ) ||
    /\bask\s+me\s+for\s+(?:the\s+)?(?:topic|subject|research area|question)\s+first\b/i.test(
      prompt,
    );
  const asksForMissingInputFirst = /\bask\s+me\s+for\s+it\s+first\b/i.test(prompt);

  const seedMode = inferMode(prompt, "");
  let objective = "";
  if (seedMode !== "lint") {
    const objectiveMatch = prompt.match(
      /\b(?:llm[- ]wiki|research vault|obsidian(?:-friendly)?(?: research)? vault|persistent markdown knowledge base)\b\s+(?:for|about|on|around|covering|focused on)\s+(.+?)(?:[.?!]|$)/i,
    );
    if (objectiveMatch) {
      objective = cleanupObjective(objectiveMatch[1] || "");
    }
  }

  if (!objective && !wantsTopicPrompt && !asksForMissingInputFirst && seedMode !== "lint") {
    const fallbackMatch = prompt.match(
      /\b(?:for|about|on|around|covering|focused on)\s+(.+?)(?:[.?!]|$)/i,
    );
    if (fallbackMatch) {
      objective = cleanupObjective(fallbackMatch[1] || "");
    }
  }

  const mode = inferMode(prompt, objective);
  const obsidian = inferObsidian(prompt);
  const args: string[] = [];
  if (objective) {
    args.push(quoteSkillSlashValue(objective));
  }
  if (mode && mode !== "auto") {
    args.push("--mode", quoteSkillSlashValue(mode));
  }
  if (obsidian && obsidian !== "auto") {
    args.push("--obsidian", quoteSkillSlashValue(obsidian));
  }

  return {
    matched: true,
    objective,
    mode,
    obsidian,
    args: args.join(" ").trim(),
  };
}
