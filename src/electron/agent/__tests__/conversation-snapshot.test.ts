/**
 * Tests for Conversation Snapshot functionality
 *
 * Tests the save/restore of conversation history for follow-up messages.
 * This ensures conversation context is preserved across:
 * - App restarts
 * - Migrations
 * - Crashes/failures
 * - Upgrades
 */

import { describe, it, expect, vi as _vi, beforeEach as _beforeEach } from "vitest";
import type { TaskEvent, LLMMessage as _LLMMessage } from "../../../shared/types";

// Type for conversation message (matches LLMMessage structure)
interface ConversationMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: Any }>;
}

// Type for snapshot payload
interface SnapshotPayload {
  conversationHistory: ConversationMessage[];
  systemPrompt: string;
  timestamp: number;
  messageCount: number;
  modelId?: string;
  modelKey?: string;
}

// Mock the restore logic (mirrors executor.ts restoreFromSnapshot)
function restoreFromSnapshot(events: TaskEvent[]): {
  restored: boolean;
  conversationHistory: ConversationMessage[];
  systemPrompt: string;
} {
  // Find the most recent conversation_snapshot event
  const snapshotEvents = events.filter((e) => e.type === "conversation_snapshot");
  if (snapshotEvents.length === 0) {
    return { restored: false, conversationHistory: [], systemPrompt: "" };
  }

  // Get the most recent snapshot (events are sorted by timestamp ascending)
  const latestSnapshot = snapshotEvents[snapshotEvents.length - 1];
  const payload = latestSnapshot.payload as SnapshotPayload;

  if (!payload?.conversationHistory || !Array.isArray(payload.conversationHistory)) {
    return { restored: false, conversationHistory: [], systemPrompt: "" };
  }

  try {
    // Restore the conversation history
    const conversationHistory = payload.conversationHistory.map((msg: Any) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    return {
      restored: true,
      conversationHistory,
      systemPrompt: payload.systemPrompt || "",
    };
  } catch  {
    return { restored: false, conversationHistory: [], systemPrompt: "" };
  }
}

// Mock the legacy fallback logic (mirrors executor.ts rebuildConversationFromEvents without snapshot)
function buildLegacySummary(
  events: TaskEvent[],
  taskTitle: string,
  taskPrompt: string,
): ConversationMessage[] {
  const conversationParts: string[] = [];

  // Add the original task as context
  conversationParts.push(`Original task: ${taskTitle}`);
  conversationParts.push(`Task details: ${taskPrompt}`);
  conversationParts.push("");
  conversationParts.push("Previous conversation summary:");

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        if (event.payload?.message) {
          conversationParts.push(`User: ${event.payload.message}`);
        }
        break;
      case "log":
        if (event.payload?.message) {
          if (event.payload.message.startsWith("User: ")) {
            conversationParts.push(`User: ${event.payload.message.slice(6)}`);
          } else {
            conversationParts.push(`System: ${event.payload.message}`);
          }
        }
        break;
      case "assistant_message":
        if (event.payload?.message) {
          const msg =
            event.payload.message.length > 500
              ? event.payload.message.slice(0, 500) + "..."
              : event.payload.message;
          conversationParts.push(`Assistant: ${msg}`);
        }
        break;
      case "tool_call":
        if (event.payload?.tool) {
          conversationParts.push(`[Used tool: ${event.payload.tool}]`);
        }
        break;
      case "tool_result":
        if (event.payload?.tool && event.payload?.result) {
          const result =
            typeof event.payload.result === "string"
              ? event.payload.result
              : JSON.stringify(event.payload.result);
          const truncated = result.length > 1000 ? result.slice(0, 1000) + "..." : result;
          conversationParts.push(`[Tool result from ${event.payload.tool}: ${truncated}]`);
        }
        break;
      case "plan_created":
        if (event.payload?.plan?.description) {
          conversationParts.push(`[Created plan: ${event.payload.plan.description}]`);
        }
        break;
      case "error":
        if (event.payload?.message || event.payload?.error) {
          conversationParts.push(`[Error: ${event.payload.message || event.payload.error}]`);
        }
        break;
    }
  }

  // Only rebuild if there's meaningful history
  if (conversationParts.length > 4) {
    return [
      {
        role: "user",
        content: conversationParts.join("\n"),
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I understand the context from our previous conversation. How can I help you now?",
          },
        ],
      },
    ];
  }

  return [];
}

// Full rebuild logic (mirrors executor.ts rebuildConversationFromEvents)
function rebuildConversationFromEvents(
  events: TaskEvent[],
  taskTitle: string,
  taskPrompt: string,
): { conversationHistory: ConversationMessage[]; restoredFromSnapshot: boolean } {
  // First, try to restore from a saved conversation snapshot
  const snapshotResult = restoreFromSnapshot(events);
  if (snapshotResult.restored) {
    return {
      conversationHistory: snapshotResult.conversationHistory,
      restoredFromSnapshot: true,
    };
  }

  // Fallback to legacy summary
  return {
    conversationHistory: buildLegacySummary(events, taskTitle, taskPrompt),
    restoredFromSnapshot: false,
  };
}

// Helper to create mock events
function createMockEvent(type: string, payload: Any, timestamp?: number): TaskEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    taskId: "test-task-id",
    type: type as Any,
    payload,
    timestamp: timestamp || Date.now(),
  };
}

// Helper to create a conversation snapshot event
function createSnapshotEvent(
  conversationHistory: ConversationMessage[],
  systemPrompt: string,
  timestamp?: number,
): TaskEvent {
  return createMockEvent(
    "conversation_snapshot",
    {
      conversationHistory,
      systemPrompt,
      timestamp: timestamp || Date.now(),
      messageCount: conversationHistory.length,
      modelId: "claude-3-sonnet",
      modelKey: "sonnet",
    },
    timestamp,
  );
}

describe("Conversation Snapshot", () => {
  describe("restoreFromSnapshot", () => {
    it("should restore conversation from a valid snapshot", () => {
      const originalHistory: ConversationMessage[] = [
        { role: "user", content: "What is the weather today?" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Let me check the weather for you." }],
        },
        { role: "user", content: "Thanks!" },
        { role: "assistant", content: [{ type: "text", text: "The weather is sunny with 72°F." }] },
      ];

      const events: TaskEvent[] = [
        createMockEvent("task_created", {}),
        createSnapshotEvent(originalHistory, "You are a helpful assistant."),
      ];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(true);
      expect(result.conversationHistory).toHaveLength(4);
      expect(result.conversationHistory[0].role).toBe("user");
      expect(result.conversationHistory[0].content).toBe("What is the weather today?");
      expect(result.systemPrompt).toBe("You are a helpful assistant.");
    });

    it("should return the most recent snapshot when multiple exist", () => {
      const oldHistory: ConversationMessage[] = [{ role: "user", content: "Old message" }];

      const newHistory: ConversationMessage[] = [
        { role: "user", content: "Old message" },
        { role: "assistant", content: [{ type: "text", text: "Old response" }] },
        { role: "user", content: "New message" },
        { role: "assistant", content: [{ type: "text", text: "New response" }] },
      ];

      const events: TaskEvent[] = [
        createSnapshotEvent(oldHistory, "Old prompt", Date.now() - 10000),
        createMockEvent("assistant_message", { message: "Something happened" }),
        createSnapshotEvent(newHistory, "New prompt", Date.now()),
      ];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(true);
      expect(result.conversationHistory).toHaveLength(4);
      expect(result.conversationHistory[2].content).toBe("New message");
      expect(result.systemPrompt).toBe("New prompt");
    });

    it("should return false when no snapshot exists", () => {
      const events: TaskEvent[] = [
        createMockEvent("task_created", {}),
        createMockEvent("assistant_message", { message: "Hello" }),
        createMockEvent("tool_call", { tool: "read_file" }),
      ];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(false);
      expect(result.conversationHistory).toHaveLength(0);
    });

    it("should return false when snapshot has invalid payload", () => {
      const events: TaskEvent[] = [createMockEvent("conversation_snapshot", { invalid: "data" })];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(false);
    });

    it("should return false when conversationHistory is not an array", () => {
      const events: TaskEvent[] = [
        createMockEvent("conversation_snapshot", {
          conversationHistory: "not an array",
          systemPrompt: "test",
        }),
      ];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(false);
    });
  });

  describe("buildLegacySummary", () => {
    it("should build summary from various event types", () => {
      const events: TaskEvent[] = [
        createMockEvent("user_message", { message: "Please read the file" }),
        createMockEvent("tool_call", { tool: "read_file" }),
        createMockEvent("tool_result", { tool: "read_file", result: "File content here" }),
        createMockEvent("assistant_message", { message: "I read the file and found the content." }),
      ];

      const result = buildLegacySummary(events, "Test Task", "Read a file");

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toContain("User: Please read the file");
      expect(result[0].content).toContain("[Used tool: read_file]");
      expect(result[0].content).toContain("[Tool result from read_file: File content here]");
      expect(result[0].content).toContain("Assistant: I read the file and found the content.");
    });

    it("should truncate long assistant messages", () => {
      const longMessage = "A".repeat(600);
      const events: TaskEvent[] = [createMockEvent("assistant_message", { message: longMessage })];

      const result = buildLegacySummary(events, "Test Task", "Test");

      expect(result[0].content).toContain("A".repeat(500) + "...");
      expect(result[0].content).not.toContain("A".repeat(600));
    });

    it("should truncate long tool results", () => {
      const longResult = "B".repeat(1100);
      const events: TaskEvent[] = [
        createMockEvent("tool_result", { tool: "read_file", result: longResult }),
      ];

      const result = buildLegacySummary(events, "Test Task", "Test");

      expect(result[0].content).toContain("B".repeat(1000) + "...");
      expect(result[0].content).not.toContain("B".repeat(1100));
    });

    it("should handle user_message events", () => {
      const events: TaskEvent[] = [
        createMockEvent("user_message", { message: "Follow-up question" }),
      ];

      const result = buildLegacySummary(events, "Test Task", "Test");

      expect(result[0].content).toContain("User: Follow-up question");
    });

    it("should handle error events", () => {
      const events: TaskEvent[] = [createMockEvent("error", { message: "Something went wrong" })];

      const result = buildLegacySummary(events, "Test Task", "Test");

      expect(result[0].content).toContain("[Error: Something went wrong]");
    });

    it("should return empty array when no meaningful history", () => {
      const events: TaskEvent[] = [];

      const result = buildLegacySummary(events, "Test Task", "Test");

      expect(result).toHaveLength(0);
    });
  });

  describe("rebuildConversationFromEvents", () => {
    it("should prioritize snapshot over legacy fallback", () => {
      const snapshotHistory: ConversationMessage[] = [
        { role: "user", content: "Question from snapshot" },
        { role: "assistant", content: [{ type: "text", text: "Answer from snapshot" }] },
      ];

      const events: TaskEvent[] = [
        createMockEvent("assistant_message", { message: "This should be ignored" }),
        createMockEvent("tool_call", { tool: "read_file" }),
        createSnapshotEvent(snapshotHistory, "System prompt"),
      ];

      const result = rebuildConversationFromEvents(events, "Task", "Prompt");

      expect(result.restoredFromSnapshot).toBe(true);
      expect(result.conversationHistory).toHaveLength(2);
      expect(result.conversationHistory[0].content).toBe("Question from snapshot");
    });

    it("should fall back to legacy when no snapshot exists", () => {
      const events: TaskEvent[] = [
        createMockEvent("user_message", { message: "User question" }),
        createMockEvent("assistant_message", { message: "Assistant response" }),
      ];

      const result = rebuildConversationFromEvents(events, "Task", "Prompt");

      expect(result.restoredFromSnapshot).toBe(false);
      expect(result.conversationHistory).toHaveLength(2);
      expect(result.conversationHistory[0].content).toContain("User question");
      expect(result.conversationHistory[0].content).toContain("Assistant response");
    });

    it("should fall back to legacy when snapshot is invalid", () => {
      const events: TaskEvent[] = [
        createMockEvent("conversation_snapshot", { invalid: "data" }),
        createMockEvent("user_message", { message: "Fallback message" }),
      ];

      const result = rebuildConversationFromEvents(events, "Task", "Prompt");

      expect(result.restoredFromSnapshot).toBe(false);
      expect(result.conversationHistory[0].content).toContain("Fallback message");
    });
  });

  describe("Conversation persistence scenarios", () => {
    it("should preserve full conversation including tool results", () => {
      // Simulate a conversation with web research
      const fullHistory: ConversationMessage[] = [
        { role: "user", content: "What is the latest news about AI?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search for the latest AI news." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "web_search",
              input: { query: "latest AI news" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Article 1: New AI breakthrough... Article 2: AI regulations...",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Here are the latest AI news: 1. New breakthrough in language models...",
            },
          ],
        },
      ];

      const events: TaskEvent[] = [createSnapshotEvent(fullHistory, "System prompt")];

      const result = restoreFromSnapshot(events);

      expect(result.restored).toBe(true);
      expect(result.conversationHistory).toHaveLength(4);

      // Verify tool results are preserved
      const toolResultMessage = result.conversationHistory[2];
      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);
    });

    it("should handle conversation after app restart", () => {
      // Simulate: Task completes, app restarts, user sends follow-up

      // Original conversation before restart
      const originalHistory: ConversationMessage[] = [
        { role: "user", content: "Analyze this codebase" },
        { role: "assistant", content: [{ type: "text", text: "I found 3 main modules..." }] },
      ];

      // Events that would be in database after restart
      const events: TaskEvent[] = [
        createMockEvent("task_created", {}, Date.now() - 60000),
        createMockEvent(
          "assistant_message",
          { message: "I found 3 main modules..." },
          Date.now() - 30000,
        ),
        createSnapshotEvent(originalHistory, "System prompt", Date.now() - 10000),
      ];

      // After restart, rebuild should restore full conversation
      const result = rebuildConversationFromEvents(
        events,
        "Analyze codebase",
        "Analyze the codebase structure",
      );

      expect(result.restoredFromSnapshot).toBe(true);
      expect(result.conversationHistory).toHaveLength(2);
      expect(result.conversationHistory[1].content).toEqual([
        { type: "text", text: "I found 3 main modules..." },
      ]);
    });

    it("should work with backward compatibility for old tasks without snapshots", () => {
      // Simulate an old task that was created before snapshot feature
      const events: TaskEvent[] = [
        createMockEvent("task_created", {}, Date.now() - 86400000), // 1 day ago
        createMockEvent("user_message", { message: "Old question" }),
        createMockEvent("tool_call", { tool: "read_file" }),
        createMockEvent("assistant_message", { message: "Old answer based on file" }),
      ];

      const result = rebuildConversationFromEvents(events, "Old Task", "Old prompt");

      // Should fall back to legacy
      expect(result.restoredFromSnapshot).toBe(false);
      expect(result.conversationHistory).toHaveLength(2);
      expect(result.conversationHistory[0].content).toContain("Old question");
      expect(result.conversationHistory[0].content).toContain("[Used tool: read_file]");
      expect(result.conversationHistory[0].content).toContain("Old answer based on file");
    });
  });
});

describe("Snapshot pruning logic", () => {
  // Mock the pruning logic (mirrors repositories.ts pruneOldSnapshots)
  function findSnapshotsToDelete(snapshots: Array<{ id: string; timestamp: number }>): string[] {
    // Sort by timestamp descending (most recent first)
    const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
    // Keep only the first one, return IDs of the rest to delete
    return sorted.slice(1).map((s) => s.id);
  }

  it("should return empty array when only one snapshot exists", () => {
    const snapshots = [{ id: "snap-1", timestamp: Date.now() }];
    const toDelete = findSnapshotsToDelete(snapshots);
    expect(toDelete).toHaveLength(0);
  });

  it("should return empty array when no snapshots exist", () => {
    const snapshots: Array<{ id: string; timestamp: number }> = [];
    const toDelete = findSnapshotsToDelete(snapshots);
    expect(toDelete).toHaveLength(0);
  });

  it("should return older snapshot IDs when multiple exist", () => {
    const snapshots = [
      { id: "snap-old", timestamp: Date.now() - 60000 },
      { id: "snap-new", timestamp: Date.now() },
      { id: "snap-oldest", timestamp: Date.now() - 120000 },
    ];
    const toDelete = findSnapshotsToDelete(snapshots);

    expect(toDelete).toHaveLength(2);
    expect(toDelete).toContain("snap-old");
    expect(toDelete).toContain("snap-oldest");
    expect(toDelete).not.toContain("snap-new");
  });

  it("should keep only the most recent snapshot", () => {
    const now = Date.now();
    const snapshots = [
      { id: "snap-1", timestamp: now - 1000 },
      { id: "snap-2", timestamp: now - 2000 },
      { id: "snap-3", timestamp: now - 3000 },
      { id: "snap-4", timestamp: now }, // Most recent
      { id: "snap-5", timestamp: now - 4000 },
    ];
    const toDelete = findSnapshotsToDelete(snapshots);

    expect(toDelete).toHaveLength(4);
    expect(toDelete).not.toContain("snap-4"); // Most recent should be kept
  });
});

describe("FileOperationTracker serialization", () => {
  // Mock the tracker serialization logic
  function serializeTracker(state: {
    readFiles: Map<string, Any>;
    createdFiles: Map<string, string>;
    directories: Map<string, Any>;
  }): { readFiles: string[]; createdFiles: string[]; directories: string[] } {
    return {
      readFiles: Array.from(state.readFiles.keys()).slice(0, 50),
      createdFiles: Array.from(state.createdFiles.values()).slice(0, 50),
      directories: Array.from(state.directories.keys()).slice(0, 20),
    };
  }

  it("should serialize tracker state correctly", () => {
    const state = {
      readFiles: new Map([
        ["/path/to/file1.ts", { count: 2, lastReadTime: Date.now(), contentLength: 1000 }],
        ["/path/to/file2.ts", { count: 1, lastReadTime: Date.now(), contentLength: 500 }],
      ]),
      createdFiles: new Map([["normalized-name", "/path/to/created.ts"]]),
      directories: new Map([
        ["/path/to/dir", { files: ["a.ts", "b.ts"], lastListTime: Date.now(), count: 1 }],
      ]),
    };

    const serialized = serializeTracker(state);

    expect(serialized.readFiles).toHaveLength(2);
    expect(serialized.readFiles).toContain("/path/to/file1.ts");
    expect(serialized.createdFiles).toHaveLength(1);
    expect(serialized.createdFiles).toContain("/path/to/created.ts");
    expect(serialized.directories).toHaveLength(1);
    expect(serialized.directories).toContain("/path/to/dir");
  });

  it("should limit serialized data to prevent huge snapshots", () => {
    const state = {
      readFiles: new Map(
        Array.from({ length: 100 }, (_, i) => [
          `/file${i}.ts`,
          { count: 1, lastReadTime: Date.now(), contentLength: 100 },
        ]),
      ),
      createdFiles: new Map(Array.from({ length: 100 }, (_, i) => [`name${i}`, `/created${i}.ts`])),
      directories: new Map(
        Array.from({ length: 50 }, (_, i) => [
          `/dir${i}`,
          { files: [], lastListTime: Date.now(), count: 1 },
        ]),
      ),
    };

    const serialized = serializeTracker(state);

    expect(serialized.readFiles).toHaveLength(50); // Limited to 50
    expect(serialized.createdFiles).toHaveLength(50); // Limited to 50
    expect(serialized.directories).toHaveLength(20); // Limited to 20
  });
});

describe("Plan context summary", () => {
  function buildPlanContextSummary(planSummary: {
    description?: string;
    completedSteps?: string[];
    failedSteps?: { description: string; error?: string }[];
  }): string {
    const parts: string[] = ["PREVIOUS TASK CONTEXT:"];

    if (planSummary.description) {
      parts.push(`Task plan: ${planSummary.description}`);
    }

    if (planSummary.completedSteps && planSummary.completedSteps.length > 0) {
      parts.push(
        `Completed steps:\n${planSummary.completedSteps.map((s) => `  - ${s}`).join("\n")}`,
      );
    }

    if (planSummary.failedSteps && planSummary.failedSteps.length > 0) {
      parts.push(
        `Failed steps:\n${planSummary.failedSteps.map((s) => `  - ${s.description}${s.error ? ` (${s.error})` : ""}`).join("\n")}`,
      );
    }

    return parts.length > 1 ? parts.join("\n") : "";
  }

  it("should build context with completed steps", () => {
    const summary = {
      description: "Analyze the codebase",
      completedSteps: ["Read main files", "Identify patterns", "Generate report"],
    };

    const context = buildPlanContextSummary(summary);

    expect(context).toContain("PREVIOUS TASK CONTEXT:");
    expect(context).toContain("Task plan: Analyze the codebase");
    expect(context).toContain("Completed steps:");
    expect(context).toContain("  - Read main files");
    expect(context).toContain("  - Identify patterns");
  });

  it("should include failed steps with errors", () => {
    const summary = {
      description: "Build project",
      completedSteps: ["Install dependencies"],
      failedSteps: [{ description: "Run tests", error: "Test timeout" }],
    };

    const context = buildPlanContextSummary(summary);

    expect(context).toContain("Failed steps:");
    expect(context).toContain("  - Run tests (Test timeout)");
  });

  it("should return empty string when no meaningful data", () => {
    const summary = {};
    const context = buildPlanContextSummary(summary);
    expect(context).toBe("");
  });
});

describe("Size-limited serialization", () => {
  const MAX_CONTENT_LENGTH = 50000;
  const MAX_TOOL_RESULT_LENGTH = 10000;

  function serializeWithSizeLimit(history: ConversationMessage[]): Any[] {
    return history.map((msg) => {
      if (typeof msg.content === "string") {
        return {
          role: msg.role,
          content:
            msg.content.length > MAX_CONTENT_LENGTH
              ? msg.content.slice(0, MAX_CONTENT_LENGTH) +
                "\n[... content truncated for snapshot ...]"
              : msg.content,
        };
      }

      if (Array.isArray(msg.content)) {
        const truncatedContent = msg.content.map((block: Any) => {
          if (block.type === "tool_result" && block.content) {
            const content =
              typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            return {
              ...block,
              content:
                content.length > MAX_TOOL_RESULT_LENGTH
                  ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + "\n[... truncated ...]"
                  : block.content,
            };
          }
          if (block.type === "text" && block.text && block.text.length > MAX_CONTENT_LENGTH) {
            return {
              ...block,
              text: block.text.slice(0, MAX_CONTENT_LENGTH) + "\n[... truncated ...]",
            };
          }
          return block;
        });
        return { role: msg.role, content: truncatedContent };
      }

      return { role: msg.role, content: msg.content };
    });
  }

  it("should truncate long string content", () => {
    const longContent = "A".repeat(60000);
    const history: ConversationMessage[] = [{ role: "user", content: longContent }];

    const serialized = serializeWithSizeLimit(history);

    expect(serialized[0].content.length).toBeLessThan(longContent.length);
    expect(serialized[0].content).toContain("[... content truncated for snapshot ...]");
  });

  it("should truncate long tool results", () => {
    const longResult = "B".repeat(15000);
    const history: ConversationMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "abc", content: longResult }],
      },
    ];

    const serialized = serializeWithSizeLimit(history);

    expect(serialized[0].content[0].content.length).toBeLessThan(longResult.length);
    expect(serialized[0].content[0].content).toContain("[... truncated ...]");
  });

  it("should not truncate small content", () => {
    const smallContent = "Hello, world!";
    const history: ConversationMessage[] = [{ role: "user", content: smallContent }];

    const serialized = serializeWithSizeLimit(history);

    expect(serialized[0].content).toBe(smallContent);
  });

  it("should preserve structure while truncating", () => {
    const history: ConversationMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Short text" },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "/test" } },
        ],
      },
    ];

    const serialized = serializeWithSizeLimit(history);

    expect(serialized[0].content).toHaveLength(2);
    expect(serialized[0].content[0].text).toBe("Short text");
    expect(serialized[0].content[1].name).toBe("read_file");
  });
});

describe("Snapshot serialization", () => {
  it("should serialize conversation with text content", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    ];

    // Serialize (as would happen in saveConversationSnapshot)
    const serialized = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Deserialize (as would happen in restoreFromSnapshot)
    const deserialized = serialized.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    expect(deserialized).toEqual(history);
  });

  it("should serialize conversation with complex content blocks", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "Use this tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Using tool..." },
          { type: "tool_use", id: "abc", name: "read_file", input: { path: "/test" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "abc", content: "File content" }],
      },
    ];

    const serialized = JSON.stringify(history);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(history);
  });
});
