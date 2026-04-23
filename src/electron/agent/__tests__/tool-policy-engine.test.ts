import { describe, expect, it } from "vitest";
import {
  evaluateToolPolicy,
  evaluateToolAvailability,
  hasPdfVisualIntent,
} from "../tool-policy-engine";

describe("tool-policy-engine request_user_input gating", () => {
  it("denies all tools in chat mode", () => {
    const decision = evaluateToolPolicy("read_file", {
      executionMode: "chat",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("chat mode");
  });

  it("allows request_user_input in plan mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "plan",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies request_user_input in execute mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "execute",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("only available in plan or debug mode");
  });

  it("denies request_user_input in analyze mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "analyze",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("only available in plan or debug mode");
  });

  it("allows request_user_input in debug mode", () => {
    const decision = evaluateToolPolicy("request_user_input", {
      executionMode: "debug",
      taskDomain: "auto",
    });
    expect(decision.decision).toBe("allow");
  });

  it("allows session checklist tools in execute mode and denies them in plan mode", () => {
    const allowed = evaluateToolPolicy("task_list_create", {
      executionMode: "execute",
      taskDomain: "auto",
    });
    const denied = evaluateToolPolicy("task_list_list", {
      executionMode: "plan",
      taskDomain: "auto",
    });

    expect(allowed.decision).toBe("allow");
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("execute, verified, or debug mode");
  });

  it("allows run_command in general domain when shell is enabled", () => {
    const decision = evaluateToolPolicy("run_command", {
      executionMode: "execute",
      taskDomain: "general",
      shellEnabled: true,
    });
    expect(decision.decision).toBe("allow");
  });

  it("still denies run_command in general domain when shell is disabled", () => {
    const decision = evaluateToolPolicy("run_command", {
      executionMode: "execute",
      taskDomain: "general",
      shellEnabled: false,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain('blocked for the "general" domain');
  });
});

describe("evaluateToolAvailability computer_use", () => {
  const baseCtx = {
    taskText: "open the ios simulator and tap the run button",
    taskDomain: "auto" as const,
    taskIntent: "general" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("allows click when native GUI intent is present", () => {
    const r = evaluateToolAvailability("click", baseCtx);
    expect(r.decision).toBe("allow");
    expect(r.metadata.overlapGroup).toBe("computer_use");
  });

  it("defers screenshot without desktop intent", () => {
    const r = evaluateToolAvailability("screenshot", {
      ...baseCtx,
      taskText: "summarize this readme",
    });
    expect(r.decision).toBe("defer");
    expect(r.reason).toBe("computer_use_intent_missing");
  });

  it("allows computer tools in operations domain", () => {
    const r = evaluateToolAvailability("type_text", {
      ...baseCtx,
      taskText: "hello",
      taskDomain: "operations",
    });
    expect(r.decision).toBe("allow");
  });

  it("allows click for native desktop app prompts like Calculator", () => {
    const r = evaluateToolAvailability("click", {
      ...baseCtx,
      taskText: "Open Calculator and click 7 + 5, then tell me the result.",
    });
    expect(r.decision).toBe("allow");
  });

  it("allows type_text for native app creation flows like Notes", () => {
    const r = evaluateToolAvailability("type_text", {
      ...baseCtx,
      taskText: "Open Notes and create a note called Test Note.",
    });
    expect(r.decision).toBe("allow");
  });

  it("still allows click when browser-ish text appears elsewhere in the prompt context", () => {
    const r = evaluateToolAvailability("click", {
      ...baseCtx,
      taskText:
        "Open Calculator and click 7 + 5, then tell me the result.\n" +
        "[AGENT_STRATEGY_CONTEXT_V1]\n" +
        "execution_contract:\n" +
        "- Use browser tools for websites only.\n" +
        "[/AGENT_STRATEGY_CONTEXT_V1]",
    });
    expect(r.decision).toBe("allow");
  });

  it("defers click for ordinary website tasks", () => {
    const r = evaluateToolAvailability("click", {
      ...baseCtx,
      taskText: "Open https://example.com and click the sign in button.",
    });
    expect(r.decision).toBe("defer");
    expect(r.reason).toBe("computer_use_intent_missing");
  });

  it("allows screen_context_resolve for vague on-screen references", () => {
    const r = evaluateToolAvailability("screen_context_resolve", {
      ...baseCtx,
      taskText: "why is this failing on screen",
    });
    expect(r.decision).toBe("allow");
    expect(r.metadata.overlapGroup).toBe("chronicle");
  });

  it("allows screen_context_resolve for side-of-screen references", () => {
    const r = evaluateToolAvailability("screen_context_resolve", {
      ...baseCtx,
      taskText: "what is this on the right side",
    });
    expect(r.decision).toBe("allow");
    expect(r.metadata.overlapGroup).toBe("chronicle");
  });

  it("defers screen_context_resolve for ordinary repo-only prompts", () => {
    const r = evaluateToolAvailability("screen_context_resolve", {
      ...baseCtx,
      taskText: "summarize this readme",
    });
    expect(r.decision).toBe("defer");
    expect(r.reason).toBe("screen_context_intent_missing");
  });
});

describe("evaluateToolAvailability open_application", () => {
  const baseCtx = {
    taskText: "Open Calculator and show me the 159th Fibonacci number.",
    taskDomain: "auto" as const,
    taskIntent: "general" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("allows open_application for native desktop app prompts", () => {
    const r = evaluateToolAvailability("open_application", baseCtx);
    expect(r.decision).toBe("allow");
  });
});

describe("evaluateToolAvailability spawn_agent", () => {
  const baseCtx = {
    taskText:
      "Use Claude Code for this task. Create a child task via acpx, have it inspect the repo and report back.",
    taskDomain: "auto" as const,
    taskIntent: "general" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("allows spawn_agent for child-task delegation prompts", () => {
    const r = evaluateToolAvailability("spawn_agent", baseCtx);
    expect(r.decision).toBe("allow");
  });
});

describe("evaluateToolAvailability run_applescript", () => {
  const baseCtx = {
    taskText: "Open Calculator and click 7 + 5, then tell me the result.",
    taskDomain: "auto" as const,
    taskIntent: "general" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("defers run_applescript for normal native GUI interaction", () => {
    const r = evaluateToolAvailability("run_applescript", baseCtx);
    expect(r.decision).toBe("defer");
    expect(r.reason).toBe("prefer_computer_use_for_native_gui");
  });

  it("allows run_applescript when the user explicitly asks for AppleScript", () => {
    const r = evaluateToolAvailability("run_applescript", {
      ...baseCtx,
      taskText: 'Write an AppleScript that tells Finder to open the Downloads folder.',
    });
    expect(r.decision).toBe("allow");
  });
});

describe("evaluateToolAvailability read_pdf_visual", () => {
  const baseCtx = {
    taskText: "Read this PDF and summarize the argument in Turkish.",
    taskDomain: "writing" as const,
    taskIntent: "general" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("defers PDF visual analysis for ordinary text-reading tasks", () => {
    const r = evaluateToolAvailability("read_pdf_visual", baseCtx);
    expect(r.decision).toBe("defer");
    expect(r.reason).toBe("pdf_visual_intent_missing");
  });

  it("allows PDF visual analysis for layout-focused tasks", () => {
    const r = evaluateToolAvailability("read_pdf_visual", {
      ...baseCtx,
      taskText: "Inspect this PDF layout, formatting, and page design.",
    });
    expect(r.decision).toBe("allow");
  });

  it("detects explicit PDF visual intent", () => {
    expect(hasPdfVisualIntent("Review the scanned PDF page layout and formatting.")).toBe(true);
    expect(hasPdfVisualIntent("Read this PDF and summarize the text.")).toBe(false);
  });
});

describe("evaluateToolAvailability create_document", () => {
  const baseCtx = {
    taskText: 'create a pdf with text "hello world"',
    taskDomain: "general" as const,
    taskIntent: "execution" as const,
    requiredTools: undefined as Iterable<string> | undefined,
    recentlyUsedTools: undefined as Iterable<string> | undefined,
  };

  it("allows create_document for explicit PDF artifact requests", () => {
    const r = evaluateToolAvailability("create_document", baseCtx);
    expect(r.decision).toBe("allow");
    expect(r.metadata.lane).toBe("artifact");
    expect(r.metadata.overlapGroup).toBe("artifact_generation");
  });
});
