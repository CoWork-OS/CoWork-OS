import { describe, expect, it } from "vitest";
import { IntentRouter } from "../IntentRouter";

describe("IntentRouter", () => {
  it.each([
    "Dayanak kayıtlarında işçinin ücret alacaklarına uygulanacak zamanaşımı süresine ilişkin emsal bir Yargıtay kararı bulabilir misin? Kararın dairesini, esas ve karar numarasını, karar tarihini belirt. İlgili paragrafı kaynak bağlantısıyla aktar ve alıntının kararla eşleştiğini kontrol et.",
    "İşçinin ücret alacaklarının zamanaşımı konusunda Dayanak kayıtlarından emsal bir Yargıtay kararı araştır. Kararın dairesini, esas ve karar numarasını ve karar tarihini belirt. İlgili paragrafı kaynak bağlantısıyla aktar; esas/karar bilgisini ve alıntıyı karar metniyle karşılaştırarak doğrula.",
    "Başka bir hizmetin kayıtlarında emsal kararı bulabilir misin?",
    "Kayıtlarda ilgili kararı arayabilir misin?",
    "İlgili kaynaklardan alıntıları getirir misin?",
    "KAYNAKLARDAKİ KARARI BULABİLİR MİSİN?",
    "Could you find a precedent in the connected records and verify its citation?",
  ])("routes source retrieval to execution regardless of phrasing: %s", (prompt) => {
    const route = IntentRouter.route("", prompt);
    expect(route.intent).toBe("execution");
    expect(route.domain).toBe("research");
    expect(route.answerFirst).toBe(false);
    expect(route.signals).toContain("source-backed-retrieval");
  });

  it.each([
    "Podes consultar os registos desse serviço?",
    "このサービスの記録を確認してもらえますか？",
    "Bu konuyu açıklar mısın?",
    "What is photosynthesis?",
  ])("does not infer terminal advice from punctuation alone: %s", (prompt) => {
    expect(IntentRouter.route("", prompt).intent).toBe("chat");
    // Without the question mark a request may route to execution; it must
    // still never become tool-less advice.
    expect(IntentRouter.route("", prompt.replace(/[?？]/g, "")).intent).not.toBe("advice");
  });

  it.each([
    "How should I find sources for a research project?",
    "Explain how to search records; do not retrieve anything.",
    "How should I approach this negotiation?",
    "What do you recommend for managing my time?",
    "What is the search_yargitay tool?",
  ])("does not mark procedural explanations as source retrieval: %s", (prompt) => {
    expect(IntentRouter.route("", prompt).signals).not.toContain("source-backed-retrieval");
  });

  it("preserves the direct advice path for an ordinary advice question", () => {
    expect(IntentRouter.route("", "How should I approach this negotiation?").intent).toBe("advice");
  });

  it("ignores AGENT_STRATEGY_CONTEXT blocks when scoring intent", () => {
    const rawPrompt = "hello";
    const decoratedPrompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
intent=deep_work
execution_contract:
- comprehensive
- long-running
[/AGENT_STRATEGY_CONTEXT_V1]`;

    const raw = IntentRouter.route("Hi", rawPrompt);
    const decorated = IntentRouter.route("Hi", decoratedPrompt);

    expect(decorated.intent).toBe(raw.intent);
    expect(decorated.domain).toBe(raw.domain);
  });

  it("keeps execution intent stable after prompt decoration", () => {
    const rawPrompt = "Search for today's Formula 1 news and summarize key driver and team updates";
    const decoratedPrompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
bounded_research=true
[/AGENT_STRATEGY_CONTEXT_V1]`;

    const raw = IntentRouter.route("Daily F1", rawPrompt);
    const decorated = IntentRouter.route("Daily F1", decoratedPrompt);

    expect(raw.intent).toBe("execution");
    expect(decorated.intent).toBe(raw.intent);
    expect(decorated.complexity).toBe(raw.complexity);
  });

  it("classifies research report compilation prompts as research domain", () => {
    const prompt =
      "Research the latest trends in AI agents from the last 1 day and compile findings into a comprehensive report.";
    const routed = IntentRouter.route("Daily AI Agent Trends Research", prompt);

    expect(routed.intent).toBe("execution");
    expect(routed.domain).toBe("research");
  });

  it("routes Turkish manuscript review as high-complexity research execution", () => {
    const routed = IntentRouter.route(
      "Yapay_Zeka_Yan_Koltukta_Baski_Hazir_v7_word_pass4",
      "Bu kitabı detaylı olarak incele; eksik ve çelişkili noktaları, bölüm geçişlerini ve karakter devamlılığını listele.",
    );

    expect(routed.intent).toBe("execution");
    expect(routed.domain).toBe("research");
    expect(routed.complexity).toBe("high");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("document-analysis");
  });

  it("does not treat booking documentation as a book document-analysis task", () => {
    const routed = IntentRouter.route("Booking docs", "review the booking documentation");

    expect(routed.signals).not.toContain("document-analysis");
    expect(routed.complexity).not.toBe("high");
  });

  it("does not treat function character counts as character-continuity analysis", () => {
    const routed = IntentRouter.route(
      "Function output",
      "analyze how many characters this function returns",
    );

    expect(routed.signals).not.toContain("document-analysis");
  });

  it("keeps compile-to-code prompts in code domain when paired with technical context", () => {
    const prompt = "Compile the TypeScript codebase and fix build errors in the repo.";
    const routed = IntentRouter.route("Fix compile failures", prompt);

    expect(routed.domain).toBe("code");
  });

  it("routes legal/doc path-heavy workflows without forcing code or deep_work", () => {
    const prompt =
      "Discover candidate files using glob patterns like **/*purchase*agreement*.* and **/*demand*letter*.*," +
      " then read each resolved document, analyze clause-level changes, and write a negotiation report.";
    const routed = IntentRouter.route("Legal negotiation review workflow", prompt);

    expect(routed.intent).toBe("workflow");
    expect(routed.domain).not.toBe("code");
    expect(routed.intent).not.toBe("deep_work");
  });

  it("routes Box file inventory questions to execution intent", () => {
    const routed = IntentRouter.route("Box files", "which files I have on box?");
    expect(routed.intent).toBe("execution");
  });

  it("routes Dropbox content listing questions to execution intent", () => {
    const routed = IntentRouter.route("Dropbox listing", "what files are in my dropbox");
    expect(routed.intent).toBe("execution");
  });

  it("routes iCloud Drive content listing questions to execution intent", () => {
    const routed = IntentRouter.route("iCloud listing", "what files are in my iCloud Drive");
    expect(routed.intent).toBe("execution");
  });

  it("routes live iCloud sync status questions on the current Mac to execution intent", () => {
    const routed = IntentRouter.route(
      "iCloud upload status",
      "can you see whats being uploaded to icloud from my mac now?",
    );

    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("live-cloud-sync-status");
  });

  it("routes urgent walkable local errand prompts to execution intent", () => {
    const routed = IntentRouter.route(
      "Urgent dress errand",
      "My kid just fell into the duck pond and the wedding starts in 30 minutes. Where can I walk and buy her a new dress?",
    );

    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("local-errand-location");
  });

  it("routes vague latest-draft screen-context prompts to execution intent", () => {
    const routed = IntentRouter.route("Draft sync", "sync the latest draft from the same doc");
    expect(routed.intent).toBe("execution");
    expect(routed.signals).toContain("needs-tool-inspection");
  });

  it("routes SSH connectivity troubleshooting prompts to execution in operations domain", () => {
    const prompt = [
      "This is the azure VM private address but I cannot connect to it",
      "alice@host % ssh user@192.0.2.10",
      "Connection closed by 192.0.2.10 port 22",
      "Zscaler is open on my mac",
    ].join("\n");

    const routed = IntentRouter.route("SSH private VM issue", prompt);
    expect(routed.intent).toBe("execution");
    expect(routed.domain).toBe("operations");
    expect(routed.signals).toContain("shell-troubleshooting");
  });

  it("routes interactive website build prompts to execution instead of advice", () => {
    const prompt =
      'Make an interactive website that scrolls horizontally with a timeline and include a "what if" toggle.';
    const routed = IntentRouter.route("Build site", prompt);
    expect(routed.intent).toBe("execution");
  });

  it("routes infographic image prompts as image creation", () => {
    const routed = IntentRouter.route(
      "Create infographic",
      "create an infographic image explaining snow leopards",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.signals).toContain("image-creation-intent");
  });

  it("routes app avatar image prompts as image creation", () => {
    const routed = IntentRouter.route(
      "Create avatar",
      "generate an image of a cool avatar of a snow leopard for cowork os app",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.signals).toContain("image-creation-intent");
  });

  it("routes explicit skill activation prompts to execution", () => {
    const routed = IntentRouter.route(
      "Novel task",
      "Use the novelist skill. Seed: a climatologist discovers a city that only exists during fog.",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("explicit-skill-invocation");
  });

  it("routes hyphenated explicit skill activation prompts to execution", () => {
    const routed = IntentRouter.route(
      "Research task",
      "Use the autoresearch-report skill. Question: how do genetic changes over time contribute to Alzheimer's?",
    );
    expect(routed.intent).toBe("execution");
    expect(routed.conversationMode).toBe("task");
    expect(routed.signals).toContain("explicit-skill-invocation");
  });

  it("does not let feature-language 'what if' force thinking intent", () => {
    const prompt =
      'Build CoworkOS distro and start implementation; include a "what if" mode in the installer wizard.';
    const routed = IntentRouter.route("CoworkOS", prompt);
    expect(routed.intent).not.toBe("thinking");
    expect(routed.intent).not.toBe("advice");
  });

  describe("coding requests", () => {
    it.each([
      ["Add dark mode to the settings screen", "code"],
      ["Refactor UserService to use dependency injection", "code"],
      ["Upgrade React to v19", "code"],
      ["Fix the null check in src/parser.ts", "code"],
      ["Convert this class component to a functional component", "code"],
      ["Add pagination to the orders table in src/pages/Orders.tsx", "code"],
      ["Rename getUser to fetchUser everywhere", "code"],
      ["Set up ESLint", "code"],
      ["Clean up unused dependencies", "code"],
      ["Make the login page remember the user's email", "code"],
      ["Debug why login fails on Safari", "code"],
      ["The app crashes on startup with TypeError: cannot read properties of undefined", "code"],
      [
        "src/utils/date.ts dosyasındaki tarih ayrıştırma hatasını düzelt ve testleri çalıştır",
        "code",
      ],
      ["package.json içindeki bağımlılıkları güncelle", "code"],
      ["Behebe den Fehler in der Login-Funktion und füge Unit-Tests hinzu", "code"],
      ["修复登录页面的错误并添加单元测试", "code"],
      ["帮我写一个Python脚本，把这个文件夹里的所有图片转换成PNG格式", "code"],
    ])("routes %s to execution in the %s domain", (prompt, domain) => {
      const routed = IntentRouter.route("", prompt);
      expect(routed.intent).toBe("execution");
      expect(routed.domain).toBe(domain);
    });

    it.each([
      "Optimize the image loading on the homepage",
      "Integrate Stripe checkout",
      "Bu projedeki giriş sayfasına şifre sıfırlama özelliği ekle",
      "Corrige el error en la función de inicio de sesión y añade pruebas",
      "Ajoute une validation au formulaire d'inscription",
      "Crea una hoja de cálculo con las ventas del último trimestre",
      "The settings page should remember the last selected tab",
    ])("routes the request %s to execution", (prompt) => {
      expect(IntentRouter.route("", prompt).intent).toBe("execution");
    });

    it.each([
      ["Erstelle eine Präsentation über unsere Quartalszahlen", "code"],
      ["Write a LinkedIn post about our launch", "code"],
      ["Draft an email to the team about the offsite", "code"],
    ])("does not put the non-code request %s in the %s domain", (prompt, domain) => {
      expect(IntentRouter.route("", prompt).domain).not.toBe(domain);
    });

    it.each([
      "How can I improve my sleep?",
      "What should I add to my resume?",
      "Why does login fail on Safari?",
    ])("keeps the question %s out of execution", (prompt) => {
      expect(IntentRouter.route("", prompt).intent).not.toBe("execution");
    });

    it.each(["hi", "thanks!", "ok", "who are you", "Sounds good", "My name is Mesut"])(
      "keeps the casual message %s as chat",
      (prompt) => {
        expect(IntentRouter.route("", prompt).intent).toBe("chat");
      },
    );
  });

  describe("redirect intent", () => {
    it("routes the canonical failure case — 'ignore X fixes, focus on new features'", () => {
      const prompt =
        "ignore the openclaw related fixes for its codebase and focus on new features or enhancements";
      const routed = IntentRouter.route("", prompt);
      expect(routed.intent).toBe("redirect");
      expect(routed.conversationMode).toBe("task");
      expect(routed.signals).toContain("redirect-ignore-pivot");
    });

    it("routes 'ignore X and do Y' pattern", () => {
      const routed = IntentRouter.route(
        "",
        "ignore the bug fixes and work on the dashboard instead",
      );
      expect(routed.intent).toBe("redirect");
    });

    it("routes explicit pivot language", () => {
      const routed = IntentRouter.route("", "let's pivot to building the authentication flow");
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-explicit-pivot");
    });

    it("routes change direction language", () => {
      const routed = IntentRouter.route("", "change direction and focus on the payment module");
      expect(routed.intent).toBe("redirect");
    });

    it("routes 'instead of X, focus on Y' contrast pattern", () => {
      const routed = IntentRouter.route(
        "",
        "instead of refactoring the old code, focus on writing new tests",
      );
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-contrast");
    });

    it("routes 'rather than X, do Y' pattern", () => {
      const routed = IntentRouter.route(
        "",
        "rather than fixing the existing bugs, build the new feature",
      );
      expect(routed.intent).toBe("redirect");
    });

    it("does not treat a rationale followed by later constraints as a task redirect", () => {
      const routed = IntentRouter.route(
        "Read orders.csv and create daily-orders-summary.md",
        "Calculate totals from the source rows rather than guessing. Use write_file exactly once, then read_file the report. Do not change the source file or take external actions.",
      );

      expect(routed.intent).toBe("execution");
      expect(routed.signals).not.toContain("redirect-contrast");
    });

    it("does not treat a negative constraint after a rationale as the redirected action", () => {
      const routed = IntentRouter.route(
        "Create daily-orders-summary.md",
        "Calculate from source rows rather than guessing, and do not use shell commands.",
      );

      expect(routed.intent).toBe("execution");
      expect(routed.signals).not.toContain("redirect-contrast");
    });

    it("routes 'forget that, work on X instead' negate-and-pivot pattern", () => {
      const routed = IntentRouter.route(
        "",
        "forget that approach and instead focus on the API layer",
      );
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-negate-pivot");
    });

    it("routes 'don't do X, focus on Y' negate-and-pivot pattern", () => {
      const routed = IntentRouter.route(
        "",
        "don't fix the styling issues, focus on the backend logic instead",
      );
      expect(routed.intent).toBe("redirect");
    });

    it("routes scope-narrowing 'focus only on Y' pattern", () => {
      const routed = IntentRouter.route("", "focus only on the new features, not the old bugs");
      expect(routed.intent).toBe("redirect");
      expect(routed.signals).toContain("redirect-scope-narrow");
    });

    it("always maps redirect intent to task conversationMode", () => {
      const prompts = [
        "ignore X and focus on Y",
        "pivot to building the new module",
        "instead of X do Y",
        "forget that and concentrate on new features",
      ];
      for (const prompt of prompts) {
        const routed = IntentRouter.route("", prompt);
        if (routed.intent === "redirect") {
          expect(routed.conversationMode).toBe("task");
        }
      }
    });

    it("does not incorrectly route simple chat messages as redirect", () => {
      const chatMessages = ["hello", "thanks for the help", "how are you?", "what did you find?"];
      for (const msg of chatMessages) {
        const routed = IntentRouter.route("", msg);
        expect(routed.intent).not.toBe("redirect");
      }
    });

    it("does not incorrectly route plain execution tasks as redirect", () => {
      const routed = IntentRouter.route("", "build a REST API for user authentication");
      expect(routed.intent).not.toBe("redirect");
    });

    it.each([
      "Instead of a modal, build a dropdown",
      "Don't change the API; focus on the caching layer you just added",
      "Leave the backend as is and focus on the frontend validation",
      "Rather than a new file, do it inside utils.ts",
      "Focus only on the files you changed",
      "Ignore the flaky e2e test for now and look at the unit test failure",
      "ignore the openclaw related fixes for its codebase and focus on new features or enhancements",
      "Start over and build it in Rust",
      "Let's do something different with the caching layer you just added",
      "Scrap that and apply the same fix to the API layer",
      "Don't forget the changelog",
      "Add a new task type to the scheduler",
      "Start over",
      "Scrap the previous approach and use Redis instead",
    ])("keeps steering and refinement follow-ups attached to prior work: %s", (message) => {
      expect(IntentRouter.isHistoryResetRedirect(message)).toBe(false);
    });

    it.each([
      "Forget that. New task: write a poem about the sea",
      "Scrap that and write a haiku about autumn",
      "Forget the X fixes, pivot to building the new onboarding flow",
      "Never mind that. Let's start over with a landing page for the bakery",
      "Something completely different: plan a team offsite agenda",
      "Forget the previous plan and draft a hiring email",
    ])("treats explicit pivots that do not refer back as a history reset: %s", (message) => {
      expect(IntentRouter.isHistoryResetRedirect(message)).toBe(true);
    });
  });
});
