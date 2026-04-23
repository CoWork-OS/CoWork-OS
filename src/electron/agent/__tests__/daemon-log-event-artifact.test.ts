import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { normalizeLlmProviderType } from "../../../shared/llmProviderDisplay";
import { LLM_PROVIDER_TYPES } from "../../../shared/types";

function createDaemonLike() {
  let seq = 0;
  return {
    logEvent: (AgentDaemon.prototype as Any).logEvent,
    taskRepo: {
      findById: vi.fn().mockReturnValue({
        id: "task-1",
        workspaceId: "workspace-1",
        agentConfig: {},
      }),
    },
    workspaceRepo: {
      findById: vi.fn().mockReturnValue({
        id: "workspace-1",
        path: "/workspace",
      }),
    },
    timelineMetrics: {
      totalEvents: 0,
      droppedEvents: 0,
      orderViolations: 0,
      stepStateMismatches: 0,
      completionGateBlocks: 0,
      evidenceGateFails: 0,
    },
    getCurrentEventSeq: vi.fn().mockReturnValue(0),
    nextEventSeq: vi.fn().mockImplementation(() => {
      seq += 1;
      return seq;
    }),
    activeTimelineStageByTask: new Map(),
    transitionTimelineStage: vi.fn(),
    trackTimelineStepState: vi.fn(),
    trackEvidenceRefs: vi.fn(),
    persistTimelineEvent: vi.fn(),
    activeTasks: new Map(),
    mediaPreviewMessagesByTask: new Map(),
    lastKnownLlmProviderByTask: new Map(),
    normalizeProviderTypeValue: (AgentDaemon.prototype as Any).normalizeProviderTypeValue,
    getProviderTypeFromLogMessage: (AgentDaemon.prototype as Any).getProviderTypeFromLogMessage,
    getProviderTypeFromPayload: (AgentDaemon.prototype as Any).getProviderTypeFromPayload,
    getTaskAgentConfigProviderType: (AgentDaemon.prototype as Any).getTaskAgentConfigProviderType,
    getActiveExecutorProviderType: (AgentDaemon.prototype as Any).getActiveExecutorProviderType,
    rememberTaskLlmProviderType: (AgentDaemon.prototype as Any).rememberTaskLlmProviderType,
    resolveTaskLlmProviderType: (AgentDaemon.prototype as Any).resolveTaskLlmProviderType,
    maybeEnrichLlmTelemetryPayload: (AgentDaemon.prototype as Any).maybeEnrichLlmTelemetryPayload,
    normalizeArtifactEventPayload: (AgentDaemon.prototype as Any).normalizeArtifactEventPayload,
    maybeEmitAssistantMediaPreview: (AgentDaemon.prototype as Any).maybeEmitAssistantMediaPreview,
  } as Any;
}

describe("AgentDaemon.logEvent artifact normalization", () => {
  it("normalizes relative artifact paths to absolute workspace paths and assigns stable label", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "artifact_created", {
      path: "reports/final.pdf",
    });

    const [timelineEvent, options] = (daemonLike.persistTimelineEvent as Any).mock.calls[0];
    expect(timelineEvent.type).toBe("timeline_artifact_emitted");
    expect(timelineEvent.payload.path).toBe("/workspace/reports/final.pdf");
    expect(timelineEvent.payload.label).toBe("final.pdf");
    expect(options.legacyType).toBe("artifact_created");
    expect(options.legacyPayload.path).toBe("/workspace/reports/final.pdf");
  });

  it("keeps URL artifacts and defaults label to the URL when missing", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "timeline_artifact_emitted", {
      path: "https://example.com/report.pdf",
    });

    const [timelineEvent] = (daemonLike.persistTimelineEvent as Any).mock.calls[0];
    expect(timelineEvent.payload.path).toBe("https://example.com/report.pdf");
    expect(timelineEvent.payload.label).toBe("https://example.com/report.pdf");
  });

  it("emits an internal assistant video preview bubble once for previewable video files", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "file_created", {
      path: "artifacts/hyperframes-demo.mp4",
      type: "video",
      mimeType: "video/mp4",
    });

    expect((daemonLike.persistTimelineEvent as Any).mock.calls).toHaveLength(2);

    const [fileEvent, fileOptions] = (daemonLike.persistTimelineEvent as Any).mock.calls[0];
    expect(fileEvent.type).toBe("timeline_artifact_emitted");
    expect(fileOptions.legacyType).toBe("file_created");

    const [assistantEvent, assistantOptions] = (daemonLike.persistTimelineEvent as Any).mock.calls[1];
    expect(assistantEvent.type).toBe("timeline_step_updated");
    expect(assistantEvent.payload.legacyType).toBe("assistant_message");
    expect(assistantEvent.payload.internal).toBe(true);
    expect(String(assistantEvent.payload.message)).toContain("::video{");
    expect(String(assistantEvent.payload.message)).toContain('path="artifacts/hyperframes-demo.mp4"');
    expect(assistantOptions.legacyType).toBe("assistant_message");

    AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "artifact_created", {
      path: "/workspace/artifacts/hyperframes-demo.mp4",
      mimeType: "video/mp4",
    });

    expect((daemonLike.persistTimelineEvent as Any).mock.calls).toHaveLength(3);
  });

  it("backfills llm_usage providerType from route logs for every registered provider", () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      const daemonLike = createDaemonLike();

      AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "log", {
        message: `LLM route selected: provider=${providerType}, profile=cheap, source=profile_model, model=gpt-5.4-mini`,
      });
      AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "llm_usage", {
        modelId: "gpt-5.4-mini",
        modelKey: "gpt-5.4-mini",
        delta: { inputTokens: 10, outputTokens: 2, cost: 0 },
      });

      const [timelineEvent, options] = (daemonLike.persistTimelineEvent as Any).mock.calls.at(-1);
      const normalizedProviderType = normalizeLlmProviderType(providerType);

      expect(timelineEvent.payload.providerType).toBe(normalizedProviderType);
      expect(options.legacyPayload.providerType).toBe(normalizedProviderType);
    }
  });

  it("falls back to the active executor provider when llm_usage arrives without structured provider metadata", () => {
    const daemonLike = createDaemonLike();
    daemonLike.activeTasks.set("task-1", {
      executor: { provider: { type: "openrouter" } },
      lastAccessed: Date.now(),
      status: "active",
    });

    AgentDaemon.prototype.logEvent.call(daemonLike, "task-1", "llm_usage", {
      modelId: "gpt-5.4",
      modelKey: "gpt-5.4",
      delta: { inputTokens: 10, outputTokens: 2, cost: 0 },
    });

    const [timelineEvent, options] = (daemonLike.persistTimelineEvent as Any).mock.calls.at(-1);
    expect(timelineEvent.payload.providerType).toBe("openrouter");
    expect(options.legacyPayload.providerType).toBe("openrouter");
  });
});

describe("AgentDaemon.emitTaskEvent legacy alias bridge", () => {
  it("emits both timeline and legacy alias events for local subscribers", () => {
    const emit = vi.fn();
    const daemonLike = {
      emit,
      resolveLegacyTaskEventAlias: (AgentDaemon.prototype as Any).resolveLegacyTaskEventAlias,
    } as Any;

    (AgentDaemon.prototype as Any).emitTaskEvent.call(daemonLike, {
      id: "event-1",
      taskId: "task-1",
      timestamp: Date.now(),
      type: "timeline_step_updated",
      payload: {
        message: "Hello from assistant",
        legacyType: "assistant_message",
      },
      schemaVersion: 2,
      legacyType: "assistant_message",
    } as Any);

    expect(emit).toHaveBeenCalledWith(
      "timeline_step_updated",
      expect.objectContaining({
        taskId: "task-1",
        type: "timeline_step_updated",
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      "assistant_message",
      expect.objectContaining({
        taskId: "task-1",
        message: "Hello from assistant",
      }),
    );
  });

  it("skips legacy error aliases when no error listener is registered", () => {
    const emit = vi.fn();
    const daemonLike = {
      emit,
      listenerCount: vi.fn().mockReturnValue(0),
      resolveLegacyTaskEventAlias: (AgentDaemon.prototype as Any).resolveLegacyTaskEventAlias,
    } as Any;

    (AgentDaemon.prototype as Any).emitTaskEvent.call(daemonLike, {
      id: "event-2",
      taskId: "task-1",
      timestamp: Date.now(),
      type: "timeline_task_status",
      payload: {
        message: "Task failed before execution started",
        legacyType: "error",
      },
      schemaVersion: 2,
      legacyType: "error",
    } as Any);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "timeline_task_status",
      expect.objectContaining({
        taskId: "task-1",
        type: "timeline_task_status",
      }),
    );
  });
});
