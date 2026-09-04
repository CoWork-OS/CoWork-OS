import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RightPanel, openPreviewableFileInSidebar } from "../RightPanel";
import {
  getProgressSectionMaterialSignature,
  getQueueSectionMaterialSignature,
  getVisibleProgressSteps,
} from "../../utils/right-panel-progress";

describe("RightPanel checklist rendering", () => {
  it("routes previewable files from the Files section to sidebar artifact viewers", () => {
    const fallback = vi.fn();
    const openers = {
      html: vi.fn(),
      spreadsheet: vi.fn(),
      document: vi.fn(),
      presentation: vi.fn(),
    };

    openPreviewableFileInSidebar("city-blueprint-preview.html", openers, fallback);
    openPreviewableFileInSidebar("budget.xlsx", openers, fallback);
    openPreviewableFileInSidebar("brief.docx", openers, fallback);
    openPreviewableFileInSidebar("notes.md", openers, fallback);
    openPreviewableFileInSidebar("deck.ppt", openers, fallback);
    openPreviewableFileInSidebar("macro-deck.pptm", openers, fallback);

    expect(openers.html).toHaveBeenCalledWith("city-blueprint-preview.html");
    expect(openers.spreadsheet).toHaveBeenCalledWith("budget.xlsx");
    expect(openers.document).toHaveBeenCalledWith("brief.docx");
    expect(openers.document).toHaveBeenCalledWith("notes.md");
    expect(openers.presentation).toHaveBeenCalledWith("deck.ppt");
    expect(openers.presentation).toHaveBeenCalledWith("macro-deck.pptm");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps non-previewable files on the modal fallback", () => {
    const fallback = vi.fn();

    const openers = {
      html: vi.fn(),
      spreadsheet: vi.fn(),
      document: vi.fn(),
      presentation: vi.fn(),
    };

    openPreviewableFileInSidebar("preview.png", openers, fallback);
    openPreviewableFileInSidebar("numbers-file.numbers", openers, fallback);
    openPreviewableFileInSidebar("pages-file.pages", openers, fallback);

    expect(fallback).toHaveBeenCalledWith("preview.png");
    expect(fallback).toHaveBeenCalledWith("numbers-file.numbers");
    expect(fallback).toHaveBeenCalledWith("pages-file.pages");
    expect(openers.spreadsheet).not.toHaveBeenCalled();
    expect(openers.document).not.toHaveBeenCalled();
  });

  it("does not render task result feedback controls for completed tasks", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "completed",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [] as Any,
      }),
    );

    expect(markup).not.toContain("Rate this result");
    expect(markup).not.toContain("Helps improve this agent and persona.");
    expect(markup).not.toContain("right-panel-feedback-card");
  });

  it("renders collaborative sub-agent totals in the right panel", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "completed",
          title: "Collaborative review",
          prompt: "Prompt",
          agentConfig: { collaborativeMode: true },
        } as Any,
        workspace: null,
        events: [] as Any,
        childTasks: [
          {
            id: "child-1",
            parentTaskId: "task-1",
            agentType: "sub",
            status: "completed",
            terminalStatus: "partial_success",
            title: "Bug and Regression Risk Review",
            prompt: "Review bugs",
            createdAt: 1000,
            updatedAt: 3000,
            completedAt: 3000,
          },
          {
            id: "child-2",
            parentTaskId: "task-1",
            agentType: "sub",
            status: "completed",
            title: "Synthesis",
            prompt: "Synthesize",
            createdAt: 2000,
            updatedAt: 5000,
            completedAt: 5000,
          },
        ] as Any,
        childEvents: [
          {
            id: "evt-1",
            taskId: "child-1",
            timestamp: 1500,
            schemaVersion: 2,
            type: "tool_call",
            payload: { tool: "read_file" },
          },
          {
            id: "evt-2",
            taskId: "child-1",
            timestamp: 2500,
            schemaVersion: 2,
            type: "llm_usage",
            payload: { totals: { inputTokens: 1000, outputTokens: 250, cost: 0.012 } },
          },
          {
            id: "evt-3",
            taskId: "child-2",
            timestamp: 4500,
            schemaVersion: 2,
            type: "llm_usage",
            payload: { totals: { inputTokens: 500, outputTokens: 100, cost: 0.003 } },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Sub Agents");
    expect(markup).toContain("2 background agents");
    expect(markup).toContain("1 done");
    expect(markup).toContain("1 warning");
    expect(markup).toContain("Tools");
    expect(markup).toContain("Tokens");
    expect(markup).toContain("1.9K");
    expect(markup).toContain("$0.015");
    expect(markup).toContain("Bug and Regression Risk Review");
    expect(markup).toContain("Needs review");
  });

  it("renders the latest session checklist state and verification nudge", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_updated",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Implement checklist primitive",
                    kind: "implementation",
                    status: "completed",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                  {
                    id: "item-2",
                    title: "Run focused verification",
                    kind: "verification",
                    status: "pending",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: true,
                nudgeReason: "Add and run a verification checklist item before finishing.",
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Checklist");
    expect(markup).toContain("Implement checklist primitive");
    expect(markup).toContain("Run focused verification");
    expect(markup).toContain("Verification");
    expect(markup).toContain("Add and run a verification checklist item before finishing.");
  });

  it("keeps the checklist visible during live execution even when items are still pending", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_created",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Draft chapter outline",
                    kind: "implementation",
                    status: "pending",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: false,
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Checklist");
    expect(markup).toContain("Draft chapter outline");
    expect(markup).toContain("Pending");
  });

  it("uses the live checklist item as fallback progress text when no plan exists", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_updated",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Update canonical target settings",
                    kind: "implementation",
                    status: "in_progress",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: false,
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Working...");
    expect(markup).toContain("Update canonical target settings");
  });

  it("shows created files while a task is still executing", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Write novel",
          prompt: "Prompt",
        } as Any,
        workspace: {
          id: "ws-1",
          name: "workspace",
          path: "/workspace",
        } as Any,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "artifact_created",
            payload: {
              path: "/workspace/artifacts/chapters/ch_01.md",
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Files");
    expect(markup).toContain('aria-label="1 file"');
    expect(markup).toContain('class="cli-file-count-number">1</span>');
    expect(markup).not.toContain(">file</span>");
    expect(markup).toContain('aria-label="Text file"');
    expect(markup).toContain("ch_01.md");
  });

  it("strips inline markdown formatting from progress step labels", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Write novel",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "plan_created",
            payload: {
              plan: {
                description: "Plan",
                steps: [
                  {
                    id: "step-1",
                    description: "**Genre**: Science fiction (Dune universe)",
                    status: "pending",
                  },
                ],
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Genre: Science fiction (Dune universe)");
    expect(markup).not.toContain("**Genre**");
  });

  it("uses the composer disclosure as the single live progress surface", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [] as Any,
        sharedTaskEventUi: {
          projectionMode: "live",
          rawEventCount: 0,
          normalizedEvents: [],
          filteredEvents: [],
          liveEvents: [],
          inspectOnlyEvents: [],
          debugOnlyEvents: [],
          parallelGroupProjection: {},
          parallelGroupsByAnchorEventId: new Map(),
          suppressedParallelEventIds: new Set(),
          toolCallPairing: { completions: new Map(), claimedResultIds: new Set() },
          baseTimelineItems: [],
          commandOutputSessions: [],
          planSteps: [
            {
              id: "step-1",
              description: "Current canonical step",
              status: "in_progress",
            },
          ],
          checklistState: null,
          files: [],
          outputSummary: null,
          toolUsage: [],
          referencedFiles: [],
          usedToolNames: new Set(),
          latestVisibleTaskEvent: null,
          activityGroups: [],
          outcomeMetrics: [],
          taskStatusStrip: {
            visible: true,
            state: "working",
            tone: "active",
            primaryLabel: "Step 1 / 1",
            compactMetricSlots: [],
            planSteps: [],
            totalPlanSteps: 1,
            updatedAt: 1,
          },
        } as Any,
      }),
    );

    expect(markup).not.toContain("Current canonical step");
    expect(markup).not.toContain("Session dashboard");
    expect(markup).not.toContain('aria-label="Session status"');
  });

  it("keeps the progress material signature stable when only array identity changes", () => {
    const planSteps = [
      { id: "step-1", description: "Inspect logs", status: "in_progress" },
      { id: "step-2", description: "Apply fix", status: "pending" },
    ] as Any;

    const signatureA = getProgressSectionMaterialSignature({
      expanded: true,
      planSteps,
      taskStatus: "executing",
      taskTerminalStatus: undefined,
      hasActiveChildren: false,
      emptyHintText: "Standing by.",
    });
    const signatureB = getProgressSectionMaterialSignature({
      expanded: true,
      planSteps: [...planSteps] as Any,
      taskStatus: "executing",
      taskTerminalStatus: undefined,
      hasActiveChildren: false,
      emptyHintText: "Standing by.",
    });

    expect(signatureA).toBe(signatureB);
  });

  it("compacts long progress plans around the current work", () => {
    const planSteps = [
      { id: "step-1", description: "Completed step 1", status: "completed" },
      { id: "step-2", description: "Completed step 2", status: "completed" },
      { id: "step-3", description: "Completed step 3", status: "completed" },
      { id: "step-4", description: "Current step", status: "in_progress" },
      { id: "step-5", description: "Pending step 5", status: "pending" },
      { id: "step-6", description: "Pending step 6", status: "pending" },
      { id: "step-7", description: "Pending step 7", status: "pending" },
      { id: "step-8", description: "Pending step 8", status: "pending" },
      { id: "step-9", description: "Pending step 9", status: "pending" },
      { id: "step-10", description: "Pending step 10", status: "pending" },
    ] as Any;

    const visible = getVisibleProgressSteps(planSteps);

    expect(visible.map((step) => step.description)).toEqual([
      "1 completed step",
      "Completed step 2",
      "Completed step 3",
      "Current step",
      "Pending step 5",
      "Pending step 6",
      "4 planned steps",
    ]);
  });

  it("changes the queue material signature only when queue content changes", () => {
    const runningTasks = [{ id: "task-1", status: "executing", title: "Build" }] as Any;
    const queuedTasks = [{ id: "task-2", status: "queued", title: "Verify" }] as Any;

    const signatureA = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks,
      queuedTasks,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });
    const signatureB = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks: [...runningTasks] as Any,
      queuedTasks: [...queuedTasks] as Any,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });
    const signatureC = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks,
      queuedTasks: [{ id: "task-3", status: "queued", title: "Ship" }] as Any,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });

    expect(signatureA).toBe(signatureB);
    expect(signatureC).not.toBe(signatureA);
  });

  it("keeps the context section visible during live execution and shows skills/tools", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 50,
            schemaVersion: 2,
            type: "skill_applied",
            payload: {
              skillName: "Novelist",
            },
          },
          {
            id: "evt-2",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "tool_call",
            payload: {
              tool: "read_file",
              input: { path: "src/index.ts" },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Context");
    expect(markup).toContain("Skills used");
    expect(markup).toContain("Novelist");
    expect(markup).toContain("Tools used");
    expect(markup).toContain("read_file");
  });
});
