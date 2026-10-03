import type { ConversationMode, TaskDomain, TaskStrategyIntent } from "../../../shared/types";
import { hasStructuralCodeSignal } from "./code-signals";

export type RoutedIntent = TaskStrategyIntent;

export type TaskComplexity = "low" | "medium" | "high";

export interface IntentRoute {
  intent: RoutedIntent;
  confidence: number;
  conversationMode: ConversationMode;
  answerFirst: boolean;
  signals: string[];
  complexity: TaskComplexity;
  domain: TaskDomain;
}

interface IntentScores {
  chat: number;
  advice: number;
  planning: number;
  execution: number;
  thinking: number;
  redirect: number;
}

// Keep a contrast pivot inside one sentence. Otherwise a phrase such as
// "rather than guessing. Do not change the source" looks like a redirect to
// the distant "do" even though it is only rationale plus a constraint.
const REDIRECT_CONTRAST_PATTERN =
  /\b(?:instead\s+of|rather\s+than)\b[^.!?\n]{0,150}\b(?:focus|work|do(?!\s+not\b)|build|create|look|tackle|explore|concentrate)\b/i;

// Phrases that abandon the previous work outright ("Forget that. New task: ...").
// Contrast ("instead of X, build Y") and scope narrowing ("focus only on ...")
// are not here: they steer the current work and need its context.
const EXPLICIT_PIVOT_PATTERN = new RegExp(
  [
    "(?<!\\b(?:don['’]?t|do\\s+not|never|not)\\s+)\\bforget\\s+(?:about\\s+)?(?:that|this|it|everything|all\\s+(?:of\\s+)?(?:that|this)|what\\s+(?:i|we|you)\\s+(?:said|asked|did)\\b|(?:the|my|your|our)\\s+(?:previous|prior|last|earlier|old|original|current|whole|entire)\\b[^.!?;:,\\n]{0,80}?(?=\\s*(?:[.!?;:,\\n]|$|\\band\\b)))",
    "\\bstart\\s+(?:over|afresh|fresh|from\\s+scratch)\\b",
    "(?:^|[.!?;\\n]\\s*)(?:(?:ok(?:ay)?|alright|now|so|next)[,\\s]+)?(?:here['’]?s\\s+|i\\s+have\\s+|(?:moving|switching)\\s+(?:on\\s+)?to\\s+)?(?:a\\s+|an\\s+|one\\s+|another\\s+)?(?:new|different|separate|unrelated)\\s+(?:task|topic|question|request|project)\\b",
    "(?<!\\btry\\s+)\\bsomething\\s+(?:completely\\s+|totally\\s+|entirely\\s+)?(?:different|unrelated)\\b(?!\\s+(?:with|for|to|in|on|about|from|than)\\b)",
    "\\bscrap\\s+(?:that|this|it|everything|all\\s+(?:of\\s+)?(?:that|this)|(?:the|my|your|our)\\s+(?:previous|prior|last|earlier|old|original|current|whole|entire)\\b[^.!?;:,\\n]{0,80}?(?=\\s*(?:[.!?;:,\\n]|$|\\band\\b)))",
    "\\bnever\\s*mind\\s+(?:that|this|it|(?:the|my)\\s+(?:previous|last|earlier|above)\\b[^.!?;:,\\n]{0,40})",
    "\\bpivot\\s+(?:to|away)\\b",
  ].join("|"),
  "gi",
);

// After the pivot phrase itself is removed, any of these means the new request
// builds on or varies the earlier work ("start over and build it in Rust", "scrap
// the previous approach and use Redis instead"), so its history must stay.
const REFERS_TO_PRIOR_WORK_PATTERN =
  /\b(?:it|its|that|those|them|instead|rather|differently|this\s+time|another\s+(?:way|approach)|the\s+same|same\s+(?:as|way|thing|approach|pattern|fix|change|code)|existing|above|earlier|previous(?:ly)?|prior|so\s+far|already|you\s+(?:just\s+|already\s+)?(?:added|changed|wrote|created|made|did|built|fixed|implemented|updated|modified|touched|edited|generated|refactored|removed|renamed|set\s+up)|your\s+(?:change|changes|fix|fixes|code|implementation|work|edits?|version|approach|branch|pr|commit|draft|output|result|solution))\b/i;

// Change verbs missing from the action-verb list ("Add dark mode ...", "Upgrade
// React ..."). They also appear in questions ("How can I improve my sleep?"), so
// they count only in request position: at the start of a clause that is not a
// question, after please/let's/"I need you to", or in "can you ...".
const REQUEST_ACTION_VERBS =
  "(?:add|refactor|change|upgrade|downgrade|convert|optimi[sz]e|integrate|improve|rewrite|port|translate|replace|extend|enable|disable|bump|patch|adjust|tweak|simplify|restructure|reorgani[sz]e|redesign|rework|polish|harden|locali[sz]e|internationali[sz]e|deprecate|debug|set\\s+up|setup|clean\\s+up|wire\\s+up|hook\\s+up|speed\\s+up)";
const CLAUSE_START_ACTION_PATTERN = new RegExp(
  `(?:^|[,:]\\s*|\\b(?:and|then|also|please|pls|now|just|let['’]?s|let\\s+us|i\\s+(?:want|need)\\s+you\\s+to|(?:we|i|you)\\s+(?:need|have|want)\\s+to|need\\s+to|go\\s+ahead\\s+and)\\s+)${REQUEST_ACTION_VERBS}\\b`,
);
const MODAL_REQUEST_ACTION_PATTERN = new RegExp(
  `\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:also\\s+)?${REQUEST_ACTION_VERBS}\\b`,
);

// A few high-frequency imperatives in other languages (tr, de, es, fr, zh) so a
// request such as "giriş sayfasına ... ekle" is not routed to chat.
const NON_ENGLISH_REQUEST_PATTERN =
  /(?:^|[^\p{L}])(?:ekle|düzelt|yap|oluştur|güncelle|füge|behebe|erstelle|ändere|aktualisiere|añade|agrega|arregla|crea|corrige|ajoute|crée)(?:y?[ıiuü]n)?(?=$|[^\p{L}])|添加|修复|创建|实现|帮我/u;

// Programming vocabulary for the code domain. Word boundaries only count Latin
// letters, so a short keyword such as "pr" does not match inside "präsentation"
// while "Python" next to Chinese text ("写一个Python脚本") still does.
const CODE_KEYWORD_PATTERN =
  /(?<![\p{Script=Latin}\p{N}_])(?:code|coding|typescript|javascript|python|rust|java|node|repo|repository|branch|commit|pull request|pr|diff|test|build|lint|debug|bug|stack trace|api|sdk)(?![\p{Script=Latin}\p{N}_])/u;
const CODE_VOCABULARY_PATTERN =
  /(?<![\p{Script=Latin}\p{N}_])(?:refactor(?:ing)?|codebase|monorepo|frontend|backend|endpoints?|dependenc(?:y|ies)|unit[\s-]+tests?|regex|sql|graphql|json|yaml|html|css|npm|pnpm|yarn|pytest|jest|vitest|eslint|prettier|webpack|git|github|gitlab|linter|oauth|jwt|webhooks?|dark\s+mode|null\s+check|http\s+client|(?:class|functional|react|ui|reusable)\s+components?|(?:login|signup|sign-up|sign-in|checkout|settings|onboarding|auth)\s+(?:page|screen|form|flow|function|module|button|endpoint|component|view))(?![\p{Script=Latin}\p{N}_])|单元测试|代码|函数|前端|后端/u;
// Framework and language names that are also English words ("react") count
// only when capitalized as proper nouns.
const CODE_PROPER_NOUN_PATTERN =
  /\b(?:React|Vue|Angular|Svelte|Next\.js|Nuxt|Django|Flask|Rails|Laravel|Spring Boot|Kotlin|Golang|PHP)\b/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IntentRouter {
  static hasSourceBackedRetrievalSignal(text: string): boolean {
    const normalized = String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\u0307/g, "");
    // Use Unicode boundaries: JS \b does not recognize Turkish letters. Match
    // retrieval actions and source objects independently of connector names.
    const sourceScope =
      /(?:^|[^\p{L}\p{N}_])(?:records?|decisions?|precedents?|sources?|citations?|passages?|databases?|documents?|reports?|(?:kayıt|karar|emsal|kaynak|alıntı|belge|dosya)[\p{L}]*)(?=$|[^\p{L}\p{N}_])/u.test(
        normalized,
      );
    const retrievalAction =
      /(?:^|[^\p{L}\p{N}_])(?:research|investigate|search|look up|retrieve|fetch|find|verify|check|compare|recommend|suggest|(?:bul|ara|araştır|getir|doğrula|karşılaştır)(?:abilir|ebilir|yabilir|yebilir|ır|ir|ur|ür|yın|yin|ın|in|ınız|iniz|abiliriz|ebiliriz|yabiliriz|yebiliriz|abilirsen|ebilirsen|yabilirsen|yebilirsen)?)(?=$|[^\p{L}\p{N}_])/u;
    const proceduralQuestion =
      /\b(?:how (?:should|can|do) i|how to|explain how|teach me how)\b|(?:^|[^\p{L}\p{N}_])nasıl\s+(?:bulurum|arayabilirim|araştırabilirim)(?=$|[^\p{L}\p{N}_])/u;
    const deniedRetrieval =
      /\b(?:do not|don't|never)\s+(?:research|investigate|search|look up|retrieve|fetch|find|verify|check|compare)\b/;
    // A procedural advice question can be followed by a separate request to
    // gather evidence. Do not let the first sentence suppress that request.
    return (
      sourceScope &&
      normalized
        .split(/[.!?;\n]+/u)
        .some(
          (clause) =>
            retrievalAction.test(clause) &&
            !proceduralQuestion.test(clause) &&
            !deniedRetrieval.test(clause),
        )
    );
  }

  private static hasDocumentAnalysisSignal(text: string): boolean {
    const normalized = String(text || "").toLowerCase();
    const documentScope =
      /\.(?:docx|pdf|epub|md|txt)\b/.test(normalized) ||
      /(?:^|[^\p{L}\p{N}_])(?:books?|manuscripts?|documents?|chapters?|character|kitap|metin|belge|doküman|bölüm|karakter)(?=$|[^\p{L}\p{N}_])/u.test(
        normalized,
      );
    const analysisIntent =
      /(?:^|[^\p{L}\p{N}_])(?:analy[sz]e|review|inspect|evaluate|summari[sz]e|contradiction|continuity|transition)(?=$|[^\p{L}\p{N}_])/u.test(
        normalized,
      ) ||
      /(?:^|[^\p{L}\p{N}_])(?:incele|analiz|değerlendir|özetle|çelişki|tutarlılık|devamlılık|geçiş|eksik)(?=$|[^\p{L}\p{N}_])/u.test(
        normalized,
      );
    return documentScope && analysisIntent;
  }

  private static normalizeSkillInvocationQuery(text: string): string {
    return String(text || "")
      .toLowerCase()
      .replace(/[-_\s]+/g, " ")
      .trim();
  }

  private static queryContainsSkillInvocationPhrase(query: string, phrase: string): boolean {
    const normalizedQuery = this.normalizeSkillInvocationQuery(query);
    const normalizedPhrase = this.normalizeSkillInvocationQuery(phrase);
    if (!normalizedQuery || !normalizedPhrase) return false;

    const pattern = normalizedPhrase
      .split(" ")
      .filter(Boolean)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    if (!pattern) return false;

    return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
  }

  private static isExplicitSkillInvocation(text: string): boolean {
    const normalized = this.normalizeSkillInvocationQuery(text);
    if (!normalized) return false;

    const activationCue =
      /\b(?:use|run|call|invoke|activate|apply|launch|start|enable|turn on|work on|help with|help me with)\b/;
    if (!activationCue.test(normalized)) return false;

    return this.queryContainsSkillInvocationPhrase(normalized, "skill");
  }

  private static getRedirectSignals(lower: string): string[] {
    const signals: string[] = [];

    if (
      /\bignore\b[\s\S]{0,150}\b(?:focus|work|do|build|create|handle|tackle|look\s+at|concentrate|instead)\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-ignore-pivot");
    }

    if (
      /\b(?:pivot\s+to|redirect\s+to|change\s+(?:the\s+)?(?:direction|focus|approach|course)|new\s+direction|different\s+direction)\b/i.test(
        lower,
      ) ||
      /\blet'?s?\s+(?:instead|pivot|redirect|change\s+(?:the\s+)?(?:direction|focus|approach))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-explicit-pivot");
    }

    if (REDIRECT_CONTRAST_PATTERN.test(lower)) {
      signals.push("redirect-contrast");
    }

    if (
      /\b(?:don'?t|skip|forget|drop|abandon|leave|set\s+aside)\b[\s\S]{0,100}\b(?:focus|instead|concentrate|and\s+(?:focus|work|do|build|look|tackle))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-negate-pivot");
    }

    if (
      /\b(?:focus\s+(?:only|just|solely|exclusively)\s+on|only\s+(?:focus|work)\s+on|concentrate\s+(?:only\s+)?on\s+(?:the\s+)?(?:new|other|different))\b/i.test(
        lower,
      )
    ) {
      signals.push("redirect-scope-narrow");
    }

    return signals;
  }

  static isRedirectIntent(text: string): boolean {
    const lower = (text || "").toLowerCase();
    return this.getRedirectSignals(lower).length > 0;
  }

  /** A change verb such as "add" or "upgrade" used as a request rather than inside a question. */
  private static hasRequestedAction(lower: string): boolean {
    return lower.split(/(?<=[.!?;])\s+|\n+/).some((sentence) => {
      const clause = sentence.trim();
      if (!clause) return false;
      if (MODAL_REQUEST_ACTION_PATTERN.test(clause)) return true;
      return !/\?\s*$/.test(clause) && CLAUSE_START_ACTION_PATTERN.test(clause);
    });
  }

  /** An instruction of at least two words: not a question or a remark about oneself. */
  private static looksLikeRequest(lower: string): boolean {
    const trimmed = lower.trim();
    if (!trimmed || /[?？]/.test(trimmed)) return false;
    if (
      /^(?:who|what|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|have|has|had|should|shall)\b/.test(
        trimmed,
      ) ||
      /^(?:my\s+name\s+is|i(?:['’]m|\s+am)\s|i\s+(?:feel|felt|was|guess|love|like|hate)\b)/.test(
        trimmed,
      )
    ) {
      return false;
    }
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed)) {
      return trimmed.length >= 2;
    }
    return trimmed.split(/\s+/).length >= 2;
  }

  /**
   * Whether a follow-up abandons the earlier work so completely that its
   * conversation history should be replaced. Only an explicit pivot ("forget
   * that", "start over", "new task:", "scrap that", "never mind that") that does
   * not refer back to the earlier work qualifies. Contrast and scope-narrowing
   * messages ("Instead of a modal, build a dropdown", "Focus only on the files
   * you changed") are redirect intents too, but they refine the current work.
   */
  static isHistoryResetRedirect(text: string): boolean {
    const lower = String(text || "").toLowerCase();
    const withoutPivots = lower.replace(EXPLICIT_PIVOT_PATTERN, " ");
    if (withoutPivots === lower) return false;
    // "Start over" or "Forget that." alone names no new work yet; keep the
    // context the next message will need.
    if ((withoutPivots.match(/[\p{L}\p{N}]+/gu) || []).length < 2) return false;
    return !REFERS_TO_PRIOR_WORK_PATTERN.test(withoutPivots);
  }

  private static stripStrategyContext(text: string): string {
    if (!text) return text;
    const open = "[AGENT_STRATEGY_CONTEXT_V1]";
    const close = "[/AGENT_STRATEGY_CONTEXT_V1]";
    const openIndex = text.indexOf(open);
    if (openIndex === -1) return text;
    const closeIndex = text.indexOf(close, openIndex);
    if (closeIndex === -1) {
      return text.slice(0, openIndex).trim();
    }
    const before = text.slice(0, openIndex).trim();
    const after = text.slice(closeIndex + close.length).trim();
    return [before, after].filter(Boolean).join("\n\n").trim();
  }

  private static inferDomain(lower: string, text: string): TaskDomain {
    const compileCodeSignal =
      /\bcompile\b/.test(lower) &&
      /\b(code|coding|typescript|javascript|python|rust|java|node|repo|repository|branch|commit|pull request|pr|diff|test|build|lint|debug|bug|stack trace|api|sdk|binary|program)\b/.test(
        lower,
      );

    const codeSignal =
      CODE_KEYWORD_PATTERN.test(lower) ||
      compileCodeSignal ||
      /`[^`]+`/.test(lower) ||
      // File paths, identifiers, code fences, and stack traces mark code work in
      // any language ("src/utils/date.ts içindeki hatayı düzelt").
      hasStructuralCodeSignal(text) ||
      CODE_VOCABULARY_PATTERN.test(lower) ||
      CODE_PROPER_NOUN_PATTERN.test(text);
    if (codeSignal) return "code";

    const operationsSignal =
      /\b(deploy|deployment|docker|kubernetes|k8s|terraform|infra|infrastructure|server|production|staging|cloud|monitoring|on-call|incident|sre|devops|vm|virtual machine|vnet|subnet|vpn|firewall|dns|ssh|private ip|zscaler)\b/.test(
        lower,
      );
    if (operationsSignal) return "operations";

    const writingSignal =
      /\b(write|draft|email|memo|proposal|blog|copywriting|linkedin post|tweet|script|rewrite|edit tone|grammar)\b/.test(
        lower,
      );
    if (writingSignal) return "writing";

    const researchSignal =
      this.hasSourceBackedRetrievalSignal(lower) ||
      this.hasDocumentAnalysisSignal(lower) ||
      /\b(research|investigate|look up|find out|analyze|analysis|compare|benchmark|sources?|citations?|market scan|trend)\b/.test(
        lower,
      );
    if (researchSignal) return "research";

    return "general";
  }

  static hasLocalErrandLocationIntent(lower: string): boolean {
    const localCue =
      /\b(?:near\s+me|nearby|close(?:st)?|walk(?:ing)?|walkable|walking\s+distance|open\s+now|nearest|around\s+me)\b/.test(
        lower,
      ) || /\bwhere\s+can\s+i\b[\s\S]{0,80}\b(?:walk|buy|get|find|pick\s+up)\b/.test(lower);
    const placeNeedCue =
      /\b(?:buy|get|find|pick\s+up|purchase|shop|store|dress|clothes|clothing|apparel|pharmacy|coffee|restaurant|food|gift|flowers|shoes|umbrella)\b/.test(
        lower,
      );
    const urgencyCue =
      /\b(?:in\s+\d+\s+(?:minutes?|mins?|hours?)|before\s+(?:my\s+)?(?:meeting|appointment|wedding|flight|train|event)|starts?\s+in\s+\d+\s+(?:minutes?|mins?|hours?)|asap|urgent|quickly|fastest)\b/.test(
        lower,
      );

    return localCue && (placeNeedCue || urgencyCue);
  }

  static route(title: string, prompt: string): IntentRoute {
    const sanitizedPrompt = this.stripStrategyContext(String(prompt || ""));
    const text = `${title || ""}\n${sanitizedPrompt}`.trim();
    const lower = text.toLowerCase();
    const scores: IntentScores = {
      chat: 0,
      advice: 0,
      planning: 0,
      execution: 0,
      thinking: 0,
      redirect: 0,
    };
    const signals: string[] = [];

    const add = (
      intent: keyof IntentScores,
      points: number,
      signal: string,
      condition: boolean,
    ) => {
      if (!condition) return;
      scores[intent] += points;
      signals.push(signal);
    };

    add(
      "chat",
      3,
      "casual-greeting",
      /^(hi|hey|hello|yo|good morning|good afternoon|good evening|how are you|thanks|thank you)\b/.test(
        lower.trim(),
      ),
    );
    add(
      "chat",
      2,
      "small-talk",
      /\b(how are you|how's it going|what's up|good night)\b/.test(lower),
    );
    add(
      "chat",
      3,
      "acknowledgement",
      /^(?:(?:ok(?:ay)?|k|cool|nice|great|awesome|perfect|got\s+it|sounds\s+good|makes\s+sense|understood|noted|no\s+worries|all\s+good|alright|fine|lol|haha|no|nope|thanks|thank\s+you|thx|(?:good|nice|great)\s+(?:job|work|one)|well\s+done)[\s.!,]*)+$/.test(
        lower.trim(),
      ),
    );
    add(
      "chat",
      3,
      "self-introduction",
      /^(?:who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|tell\s+me\s+about\s+yourself|introduce\s+yourself)[\s.!?]*$/.test(
        lower.trim(),
      ),
    );
    add(
      "advice",
      3,
      "advice-question",
      /\b(how should i|what should i|what do you suggest|recommend|advice)\b/.test(lower),
    );
    add(
      "planning",
      3,
      "strategy-language",
      /\b(strategy|roadmap|positioning|go to market|gtm|target segment|messaging|kpi|objective)\b/.test(
        lower,
      ),
    );
    add(
      "planning",
      2,
      "planning-language",
      /\b(plan|planning|phase|milestone|timeline)\b/.test(lower),
    );
    add(
      "execution",
      3,
      "action-verb",
      /\b(create|build|make|edit|write|fix|deploy|run|install|execute|open|search|fetch|schedule|configure|implement|check|read|review|find|analyze|examine|inspect|list|show|scan|look|update|modify|delete|remove|rename|move|copy|test|verify|continue|commit|push|pull|merge|raise|raised|cherry-?pick|rebase|revert|publish|release|tag|submit|approve|request|close|research|investigate|summarize|compare|generate|draft|prepare|export|troubleshoot|diagnose|explore|spawn|crawl|scrape|extract|index|monitor|track|profile|audit|map|catalog|enumerate|parse|process|transform|migrate|sync|import|clone|fork|draw|paint|illustrate|render|sketch)\b/.test(
        lower,
      ),
    );
    add("execution", 3, "requested-action", this.hasRequestedAction(lower));
    add("execution", 3, "non-english-request", NON_ENGLISH_REQUEST_PATTERN.test(lower));
    const documentAnalysisSignal = this.hasDocumentAnalysisSignal(lower);
    add("execution", 6, "document-analysis", documentAnalysisSignal);
    add("execution", 6, "source-backed-retrieval", this.hasSourceBackedRetrievalSignal(lower));
    add(
      "execution",
      2,
      "execution-target",
      /\b(files?|folders?|repos?|projects?|commands?|scripts?|code|apps?|databases?|tests?|workspaces?|docs?|documents?|directories?|packages?|prs?|pull\s*requests?|branches?|commits?|releases?|tags?|issues?|pipelines?|builds?|reports?|presentations?|spreadsheets?|data|results|findings|sources|summary|analysis|insights|metrics|websites?|web\s*pages?|webapps?|frontend|landing\s*pages?)\b/.test(
        lower,
      ),
    );
    add(
      "execution",
      2,
      "path-or-command",
      /`[^`]+`|\/[a-z0-9_./-]+|\bnpm\b|\byarn\b|\bpnpm\b|\bgit\b/.test(lower),
    );
    add("execution", 4, "explicit-skill-invocation", this.isExplicitSkillInvocation(lower));
    const shellCommandMentioned =
      /\b(ssh|scp|sftp|ping|traceroute|mtr|nc|netcat|telnet|dig|nslookup|nmap|ifconfig|ipconfig|route)\b/.test(
        lower,
      );
    const connectivityIssueMentioned =
      /\b(can(?:not|'t)\s+connect|unable to connect|connection\s+(?:closed|refused|reset|timed?\s*out)|no route to host|network is unreachable|host unreachable|permission denied|port\s+\d+)\b/.test(
        lower,
      );
    const terminalTranscriptMentioned = /(?:^|\n)\S+@\S+[^\n]*(?:[$%#])\s+/.test(text);
    add(
      "execution",
      4,
      "shell-troubleshooting",
      shellCommandMentioned && connectivityIssueMentioned,
    );
    add(
      "execution",
      2,
      "terminal-transcript",
      terminalTranscriptMentioned && shellCommandMentioned,
    );
    // Punctuation does not distinguish advice from a polite request to act.
    // Unrecognized languages retain the normal tool-capable conversation path.
    add(
      "execution",
      3,
      "needs-tool-inspection",
      /\b(my screen|my display|screenshot|on screen|latest draft|same doc|what is this|why is this failing|the failing one|disk space|storage|battery|cpu|memory|ram|running apps?|running process|installed|clipboard|weather|temperature|stock price|exchange rate|current time|what time)\b/i.test(
        lower,
      ),
    );
    add("execution", 5, "local-errand-location", this.hasLocalErrandLocationIntent(lower));
    const cloudProviderMentioned =
      /\b(box|dropbox|one[\s-]?drive|google drive|sharepoint|notion|i[\s-]?cloud(?:\s+drive)?)\b/.test(
        lower,
      );
    const cloudFileObjectMentioned =
      /\b(files?|folders?|documents?|docs?|pages?|items?|storage|content)\b/.test(lower);
    const cloudQueryIntent =
      /\b(list|show|find|search|fetch|read|get|open|what|which|where|have|see)\b/.test(lower);
    add(
      "execution",
      3,
      "cloud-storage-file-access",
      cloudProviderMentioned && cloudFileObjectMentioned,
    );
    add("execution", 2, "cloud-storage-query", cloudProviderMentioned && cloudQueryIntent);
    add(
      "execution",
      3,
      "live-cloud-sync-status",
      /\bi[\s-]?cloud\b/.test(lower) &&
        /\b(upload(?:ed|ing)?|sync(?:ing|ed)?|downloading|status|activity)\b/.test(lower) &&
        /\b(my|this)\s+mac\b|\bon my mac\b|\bfrom my mac\b|\bright now\b|\bnow\b/.test(lower),
    );
    // Image creation: draw, create image, generate picture, etc.
    add(
      "execution",
      4,
      "image-creation-intent",
      /\b(draw|paint|illustrate|render|sketch)\b.*\b(in|of|a|an|the)\b/.test(lower) ||
        /\b(create|generate|make)\s+(?:an?\s+)?(?:image|picture|photo|illustration)\s+(?:of|with|about|for|on|explaining?)\b/i.test(
          lower,
        ) ||
        /\b(create|generate|make)\s+(?:an?\s+)?(?:infographic|poster)(?:\s+image)?\b/i.test(lower),
    );

    // Redirect / re-scope intent — user is pivoting away from prior work to a new direction.
    // Scored separately so it can win decisively over "execution" when both are present.
    const redirectSignals = this.getRedirectSignals(lower);
    add("redirect", 5, "redirect-ignore-pivot", redirectSignals.includes("redirect-ignore-pivot"));
    add(
      "redirect",
      5,
      "redirect-explicit-pivot",
      redirectSignals.includes("redirect-explicit-pivot"),
    );
    add("redirect", 4, "redirect-contrast", redirectSignals.includes("redirect-contrast"));
    add("redirect", 4, "redirect-negate-pivot", redirectSignals.includes("redirect-negate-pivot"));
    add("redirect", 3, "redirect-scope-narrow", redirectSignals.includes("redirect-scope-narrow"));

    // "Think with me" mode — Socratic reasoning, not task execution
    add(
      "thinking",
      3,
      "think-with-me",
      /\b(think (with|through|about) (me|this|it)|brainstorm|let'?s think|help me (think|decide|figure|reason)|weigh (the |my )?options)\b/.test(
        lower,
      ),
    );
    add(
      "thinking",
      2,
      "exploratory-reasoning",
      /\b(pros and cons|trade-?offs|devil'?s advocate|on the other hand|explore (the |my )?(idea|options|angles))\b/.test(
        lower,
      ),
    );
    add(
      "thinking",
      2,
      "what-if-exploration",
      /\bwhat if\b/.test(lower) &&
        /\?/.test(text) &&
        !/\b(toggle|mode|button|switch|option|panel|feature|tab)\b/.test(lower),
    );

    // Workflow detection — sequential multi-phase prompts ("research X then create Y then email Z")
    const workflowConnectives =
      /\b(then|after that|after this|next|and then|finally|once done|once that'?s done|step \d|→|➜|->)\b/i;
    const hasWorkflowConnectives = workflowConnectives.test(lower);
    const actionVerbMatches =
      lower.match(
        /\b(create|build|make|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify|research|analyze|summarize|generate|send|email|present|export|schedule|review|compile|draft|prepare|deliver|share|upload|publish|troubleshoot|diagnose)\b/g,
      ) || [];
    const uniqueActionVerbs = new Set(actionVerbMatches).size;

    add(
      "execution",
      0, // don't add score, just detect
      "workflow-pipeline",
      hasWorkflowConnectives && uniqueActionVerbs >= 3,
    );

    // Deep work detection — long-running autonomous tasks
    const hasDeepWorkSignal =
      /\b(deep\s+work|fire\s+and\s+forget|long[- ]running|autonomous(?:ly)?|end[- ]to[- ]end|from\s+scratch|comprehensive|production[- ]ready|full[- ]stack|set\s+(?:it\s+)?up\s+(?:everything|all)|build\s+(?:me\s+)?a\s+(?:complete|full|entire)|kick\s+(?:it\s+)?off\s+and)\b/i.test(
        lower,
      );
    if (hasDeepWorkSignal) {
      signals.push("deep-work-signal");
    }

    const planningLike = scores.planning + scores.advice;
    const executionLike = scores.execution;
    const chatLike = scores.chat;
    const thinkingLike = scores.thinking;
    const redirectLike = scores.redirect;

    // Complexity scoring: how multi-faceted or demanding is this prompt?
    const wordCount = text.split(/\s+/).length;
    const actionVerbCount = (
      lower.match(
        /\b(create|build|make|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify|troubleshoot|diagnose)\b/g,
      ) || []
    ).length;
    const hasMultipleSteps =
      /\b(then|after that|next|also|additionally|and then|finally|first|second|third)\b/.test(
        lower,
      );

    // Deep work should require an explicit autonomy signal from the user.
    const isDeepWork =
      hasDeepWorkSignal && executionLike >= 3 && (wordCount > 100 || uniqueActionVerbs >= 4);

    let intent: RoutedIntent;
    // Redirect: checked first — a pivot message wins over all other intents,
    // including deep_work. "build this end-to-end from scratch" is still a
    // redirect if it's prefaced by "forget the current plan and…".
    if (redirectLike >= 3) {
      intent = "redirect";
      // Deep work: long-running autonomous execution
    } else if (isDeepWork) {
      intent = "deep_work";
      // Multi-phase workflow: 3+ distinct action verbs with sequential connectives
    } else if (hasWorkflowConnectives && uniqueActionVerbs >= 3 && executionLike >= 3) {
      intent = "workflow";
    } else if (thinkingLike >= 3 && executionLike < 3) {
      intent = "thinking";
    } else if (chatLike >= 3 && planningLike === 0 && executionLike === 0 && thinkingLike === 0) {
      intent = "chat";
    } else if (planningLike >= 3 && executionLike >= 3) {
      intent = "mixed";
    } else if (scores.planning >= scores.advice && scores.planning >= 3) {
      intent = "planning";
    } else if (scores.advice >= 3 && executionLike === 0) {
      intent = "advice";
    } else if (executionLike >= 3) {
      intent = "execution";
    } else if (planningLike >= 2) {
      intent = "advice";
    } else if (chatLike === 0 && this.looksLikeRequest(lower)) {
      // A request with no chat cue whose wording the lists above miss ("The
      // settings page should remember the last tab", another language) still
      // asks for work; routing it to chat stripped its tools in plan mode.
      intent = "execution";
    } else {
      intent = "chat";
    }

    const confidenceBase = Math.max(
      chatLike,
      planningLike,
      executionLike,
      thinkingLike,
      redirectLike,
    );
    const confidenceSpread = Math.abs(planningLike + executionLike - chatLike);
    const confidence = clamp(0.55 + confidenceBase * 0.08 + confidenceSpread * 0.02, 0.55, 0.95);

    const conversationMode: ConversationMode =
      intent === "chat"
        ? "chat"
        : intent === "thinking"
          ? "think"
          : intent === "execution" ||
              intent === "workflow" ||
              intent === "deep_work" ||
              intent === "redirect"
            ? "task"
            : "hybrid";

    const answerFirst =
      intent === "advice" || intent === "planning" || intent === "mixed" || intent === "thinking";

    let complexity: TaskComplexity;
    if (
      documentAnalysisSignal ||
      wordCount > 150 ||
      actionVerbCount >= 4 ||
      (hasMultipleSteps && actionVerbCount >= 2)
    ) {
      complexity = "high";
    } else if (wordCount > 60 || actionVerbCount >= 2 || hasMultipleSteps) {
      complexity = "medium";
    } else {
      complexity = "low";
    }

    const domain = this.inferDomain(lower, text);

    return {
      intent,
      confidence,
      conversationMode,
      answerFirst,
      signals,
      complexity,
      domain,
    };
  }
}
