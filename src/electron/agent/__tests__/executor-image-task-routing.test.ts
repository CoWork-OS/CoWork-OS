/**
 * Image-task routing: text-to-image intent detection, no mandatory verification
 * step for image tasks, and no desktop computer-use tools in steps that check
 * or repair a deliverable unless the user asked for native app control.
 */

import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { VERIFICATION_REPAIR_STEP_DESCRIPTION } from "../executor-verification-repair-utils";
import { hasNativeDesktopGuiIntent } from "../tool-policy-engine";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

const BANNER_PROMPT =
  "Generate a 16:9 banner for our launch that reads “COWORK OS 2.0”, dark background, neon accents";

const GUI_TOOLS = ["open_application", "screenshot", "click", "type_text", "keypress"];

function createExecutor(prompt: string, title = "Task"): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title, prompt, rawPrompt: prompt, agentConfig: {} };
  executor.workspace = { id: "ws-1", path: "/tmp", permissions: { shell: true } };
  executor.lastUserMessage = "";
  executor.lastAssistantOutput = null;
  executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
  executor.getEffectiveTaskDomain = vi.fn().mockReturnValue("general");
  executor.shouldCompactToolResultsForLocalModel = vi.fn().mockReturnValue(false);
  executor.capToolCount = vi.fn((tools: Any[]) => tools);
  return executor;
}

function scopedToolNames(executor: Any, step: Any, tools: Any[]): string[] {
  executor.plan = { description: "P", steps: [step] };
  executor.currentStepId = step.id;
  return executor.applyStepScopedToolPolicy(tools).map((tool: Any) => tool.name);
}

const CATALOG = [
  { name: "read_file" },
  { name: "get_file_info" },
  { name: "analyze_image" },
  { name: "browser_navigate" },
  { name: "generate_image" },
  ...GUI_TOOLS.map((name) => ({ name })),
  { name: "mcp_desktop_click", runtime: { capabilityTags: ["system", "mcp"] } },
];

describe("text-to-image intent", () => {
  it.each([
    BANNER_PROMPT,
    "Generate a COWORK OS 2.0 banner",
    "make a 4K wallpaper of a mountain lake at dusk",
    "create a 1920×1080 hero image of a forest",
    "design a 50% transparent logo",
  ])("detects %s", (prompt) => {
    const executor = createExecutor(prompt);
    expect(executor.hasTextToImageGenerationIntent(prompt.toLowerCase())).toBe(true);
  });

  it.each([
    "create notes.md describing the image",
    "Create report.md with an image of the chart",
    "create a website that has a banner",
    "Write a python script that generates images",
  ])("does not detect %s", (prompt) => {
    const executor = createExecutor(prompt);
    expect(executor.hasTextToImageGenerationIntent(prompt.toLowerCase())).toBe(false);
  });

  it.each([
    "Use the pdf-storybook skill on delta-field-guide.pdf. For every picture use the Qwen Image MCP tool to generate an image of each chapter, then animate 2 chapters.",
    "Generate an image of a river delta and show it in Live Canvas",
    "create a picture of a fox, then turn it into a short video clip",
    "make an image of the chart from report.pdf",
    "generate an image of each chapter and export the page",
  ])("plans multi-part work that includes pictures: %s", (prompt) => {
    const executor = createExecutor(prompt);
    expect(executor.isSimpleImageGenerationTask()).toBe(false);
  });

  it("routes the launch banner prompt to the simple image path", () => {
    const executor = createExecutor(BANNER_PROMPT, "Launch banner");
    expect(executor.isSimpleImageGenerationTask()).toBe(true);
  });
});

describe("canvas availability", () => {
  it("offers canvas tools when a plan step builds the canvas, even if the prompt does not say so", () => {
    const executor = createExecutor("Use the pdf-storybook skill on delta-field-guide.pdf.");
    executor.getContractPrompt = () => executor.task.prompt;
    expect(executor.isVisualCanvasTask()).toBe(false);
    executor.plan = {
      description: "P",
      steps: [
        {
          id: "3",
          description: "Create the Live Canvas story with five chapters.",
          status: "pending",
        },
      ],
    };
    expect(executor.isVisualCanvasTask()).toBe(true);
  });
});

describe("canvas tools in later steps", () => {
  const catalog = [
    { name: "write_file" },
    { name: "copy_file" },
    { name: "canvas_push" },
    { name: "canvas_add_asset" },
    { name: "canvas_export" },
    { name: "canvas_snapshot" },
  ];
  const step = {
    id: "4",
    kind: "primary",
    description:
      "Generate five chapter pictures, copy each one into the workspace and register it.",
    status: "pending",
  };

  it("keeps canvas tools available once the task has a canvas page", () => {
    const executor = createExecutor("Use the pdf-storybook skill on delta-field-guide.pdf.");
    executor.toolRegistry = { getLatestCanvasSessionId: () => "canvas-1" };
    const names = scopedToolNames(executor, step, catalog);
    expect(names).toEqual(
      expect.arrayContaining(["canvas_add_asset", "canvas_push", "canvas_export"]),
    );
  });

  it("does not add canvas tools when the task has no canvas", () => {
    const executor = createExecutor("Use the pdf-storybook skill on delta-field-guide.pdf.");
    executor.toolRegistry = { getLatestCanvasSessionId: () => null };
    const names = scopedToolNames(executor, step, catalog);
    expect(names).not.toContain("canvas_add_asset");
  });
});

describe("verification step requirement for image tasks", () => {
  it("does not require a verification step for an image task", () => {
    const executor = createExecutor("create an infographic about cowork os");
    expect(executor.isTerminalImageGenerationTask()).toBe(true);
    expect(executor.isImageGenerationTaskWithoutRequestedVerification()).toBe(true);
  });

  it("keeps the verification step when the user asks to verify the image", () => {
    const executor = createExecutor(
      "create an infographic about cowork os and verify the headline text",
    );
    expect(executor.isImageGenerationTaskWithoutRequestedVerification()).toBe(false);
  });

  it("keeps the verification step for non-image tasks", () => {
    const executor = createExecutor("Write the release notes to release.md");
    expect(executor.isImageGenerationTaskWithoutRequestedVerification()).toBe(false);
  });
});

describe("desktop GUI tools in step scoping", () => {
  it("does not read native GUI intent from the model's own output", () => {
    const executor = createExecutor(
      "Summarize our launch plan into summary.md",
      "Launch plan summary",
    );
    executor.lastAssistantOutput =
      "I'll open the Notes app and click through the launch notes, adding a provenance note.";
    // The assistant text alone would read as a native app request.
    expect(hasNativeDesktopGuiIntent(executor.lastAssistantOutput.toLowerCase())).toBe(true);
    const names = scopedToolNames(
      executor,
      { id: "1", description: "Summarize the launch plan", kind: "primary", status: "pending" },
      CATALOG,
    );
    for (const tool of GUI_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain("read_file");
  });

  it("removes computer-use tools from a verification step the model described with an app", () => {
    const executor = createExecutor("Draft the release notes for our launch in release.md");
    const description = "Open release.md in Preview, take a screenshot and verify the headings";
    // The step description alone grants the desktop tools in the allowlist.
    expect(
      executor
        .buildStepToolAllowlist(
          { requiredTools: new Set() },
          "verification",
          "general",
          description,
        )
        .has("open_application"),
    ).toBe(true);
    const names = scopedToolNames(
      executor,
      { id: "2", description, kind: "verification", status: "pending" },
      CATALOG,
    );
    for (const tool of [...GUI_TOOLS, "mcp_desktop_click"]) expect(names).not.toContain(tool);
    expect(names).toEqual(expect.arrayContaining(["read_file", "get_file_info", "analyze_image"]));
    // Browser checks of web deliverables stay available.
    expect(names).toContain("browser_navigate");
  });

  it("removes computer-use tools from a verification repair step", () => {
    const executor = createExecutor("Draft the release notes for our launch in release.md");
    executor.lastAssistantOutput = "FAIL_BLOCKING: open Preview and click the title";
    const names = scopedToolNames(
      executor,
      {
        id: "3",
        description: VERIFICATION_REPAIR_STEP_DESCRIPTION,
        kind: "recovery",
        status: "pending",
      },
      CATALOG,
    );
    for (const tool of [...GUI_TOOLS, "mcp_desktop_click"]) expect(names).not.toContain(tool);
  });

  it("removes computer-use tools from a verification step of a grounded image task", () => {
    const executor = createExecutor("create an infographic about cowork os");
    const names = scopedToolNames(
      executor,
      {
        id: "3",
        description: "Open the infographic in Preview and check the text with a screenshot",
        kind: "verification",
        status: "pending",
      },
      CATALOG,
    );
    for (const tool of [...GUI_TOOLS, "mcp_desktop_click"]) expect(names).not.toContain(tool);
    expect(names).toEqual(expect.arrayContaining(["generate_image", "get_file_info"]));
  });

  it("keeps computer-use tools when the user asked to drive a native app", () => {
    const executor = createExecutor("Open Calculator and show me 12 times 12", "Open Calculator");
    const names = scopedToolNames(
      executor,
      {
        id: "2",
        description: "Take a screenshot of Calculator to confirm the result",
        kind: "verification",
        status: "pending",
      },
      CATALOG,
    );
    expect(names).toEqual(expect.arrayContaining(["open_application", "screenshot"]));
  });
});
