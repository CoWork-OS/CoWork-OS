/**
 * The ChatGPT importer writes only through the gated import API
 * (`MemoryService.openImportSession`): facts about the user ("observation" entries) are
 * marked as facts, a failed distillation is not counted as processed, and a refused
 * session (memory off, privacy mode disabled) fails the import without writing.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openImportSession: vi.fn(),
  createMessage: vi.fn(),
  importedRows: [] as Array<{ content: string }>,
}));

vi.mock("../../agent/llm", () => ({
  LLMProviderFactory: {
    createProvider: () => ({ type: "openai", createMessage: mocks.createMessage }),
    getSettings: () => ({ modelKey: "m", providerType: "openai" }),
    getModelId: () => "m",
  },
}));
vi.mock("../../agent/llm/usage-telemetry", () => ({
  recordLlmCallSuccess: vi.fn(),
  recordLlmCallError: vi.fn(),
}));
vi.mock("../../database/schema", () => ({
  DatabaseManager: { getInstance: () => ({ getDatabase: () => ({}) }) },
}));
vi.mock("../memory-statement-port", () => ({
  createMemoryStatementPort: () => ({ all: async () => mocks.importedRows }),
}));
vi.mock("../MemoryService", () => ({
  MemoryService: { openImportSession: mocks.openImportSession },
}));

import { ChatGPTImporter } from "../ChatGPTImporter";

function conversation(id: string, title: string) {
  return {
    conversation_id: id,
    title,
    update_time: 2,
    mapping: {
      a: {
        id: "a",
        message: { author: { role: "user" }, content: { parts: ["I use TS"] }, create_time: 1 },
      },
      b: {
        id: "b",
        message: { author: { role: "assistant" }, content: { parts: ["Noted"] }, create_time: 2 },
      },
    },
  };
}

describe("ChatGPTImporter", () => {
  let dir: string;
  let filePath: string;
  let added: Array<Record<string, unknown>>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-import-"));
    filePath = path.join(dir, "conversations.json");
    await fs.writeFile(
      filePath,
      JSON.stringify([conversation("c-1", "Stack"), conversation("c-2", "Later")]),
    );
    added = [];
    mocks.importedRows = [];
    mocks.openImportSession.mockReset();
    mocks.openImportSession.mockResolvedValue({
      workspaceId: "ws-1",
      isPrivate: false,
      add: vi.fn(async (entry: Record<string, unknown>) => {
        added.push(entry);
        return { status: "created", memory: { id: `m-${added.length}` } };
      }),
      finish: vi.fn(async () => ({ created: added.length })),
    });
    mocks.createMessage.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores distilled entries through the import session and marks user facts", async () => {
    mocks.createMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { type: "observation", content: "Uses TypeScript daily" },
            { type: "decision", content: "Chose Vitest over Jest" },
          ]),
        },
      ],
    });
    mocks.createMessage.mockRejectedValueOnce(new Error("rate limited"));

    const result = await ChatGPTImporter.import({ workspaceId: "ws-1", filePath });

    expect(mocks.openImportSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      forcePrivate: false,
    });
    expect(added).toEqual([
      {
        type: "observation",
        body: "Uses TypeScript daily",
        header: '[Imported from ChatGPT — "Stack" (conv:c-1)]',
        fact: { kind: "preference", importer: "chatgpt", conversationId: "c-1" },
      },
      {
        type: "decision",
        body: "Chose Vitest over Jest",
        header: '[Imported from ChatGPT — "Stack" (conv:c-1)]',
      },
    ]);
    // The failed distillation is an error, not a processed conversation (retried next time).
    expect(result).toMatchObject({ memoriesCreated: 2, conversationsProcessed: 1 });
    expect(result.errors).toEqual(['"Later": distillation failed']);
  });

  it("skips conversations already imported and visible in the workspace", async () => {
    mocks.importedRows = [{ content: '[Imported from ChatGPT — "Stack" (conv:c-1)]\nUses TS' }];
    mocks.createMessage.mockResolvedValue({ content: [{ type: "text", text: "[]" }] });
    const result = await ChatGPTImporter.import({ workspaceId: "ws-1", filePath });
    expect(result.skipped).toBe(1);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
  });

  it("fails without writing when the import session is refused", async () => {
    mocks.openImportSession.mockRejectedValue(
      new Error("Memory system is disabled for this workspace."),
    );
    const result = await ChatGPTImporter.import({ workspaceId: "ws-1", filePath });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/disabled/);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});
