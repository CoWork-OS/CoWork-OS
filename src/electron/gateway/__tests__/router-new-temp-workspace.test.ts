import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
      close: vi.fn(),
    })),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
  },
}));

import { TEMP_WORKSPACE_ID_PREFIX, TEMP_WORKSPACE_ROOT_DIR_NAME } from "../../../shared/types";
import { MessageRouter } from "../router";

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Any) => fn),
  } as Any;
}

describe("MessageRouter /new temp", () => {
  it("selects a fresh gateway temp workspace for the chat session", async () => {
    const router = new MessageRouter(createMockDb(), {}, undefined);
    const setSessionWorkspace = vi.fn();
    (router as Any).sessionRepo.findById = vi.fn().mockReturnValue({
      id: "session-1",
      taskId: null,
      workspaceId: "real-workspace",
    });
    (router as Any).workspaceRepo.findById = vi.fn().mockReturnValue(undefined);
    (router as Any).sessionManager.setSessionWorkspace = setSessionWorkspace;

    const sendMessage = vi.fn().mockResolvedValue("msg-1");
    const adapter = {
      type: "whatsapp",
      status: "connected",
      onMessage: vi.fn(),
      onError: vi.fn(),
      onStatusChange: vi.fn(),
      sendMessage,
    } as Any;
    router.registerAdapter(adapter, "whatsapp-1");

    await (router as Any).handleNewTaskCommand(
      adapter,
      {
        chatId: "chat-1",
        messageId: "incoming-1",
      },
      "session-1",
      ["temp"],
    );

    expect(setSessionWorkspace).toHaveBeenCalledTimes(1);
    const workspaceId = setSessionWorkspace.mock.calls[0]?.[1] as string;
    expect(workspaceId).toMatch(new RegExp(`^${TEMP_WORKSPACE_ID_PREFIX}gateway-session-1-`));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        parseMode: "markdown",
        text: expect.stringContaining("Ready for a new temporary session"),
      }),
    );
    expect(sendMessage.mock.calls[0]?.[0]?.text).not.toContain("Workspace:");
  });

  it("excludes temp-root workspaces from /workspaces", async () => {
    const router = new MessageRouter(createMockDb(), {}, undefined);
    (router as Any).workspaceRepo.findAll = vi.fn().mockReturnValue([
      {
        id: "real-1",
        name: "Real Workspace",
        path: "/Users/test/project",
        permissions: {},
      },
      {
        id: "legacy-temp-row",
        name: "Temporary Workspace",
        path: path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME, "gateway-old"),
        permissions: {},
      },
      {
        id: `${TEMP_WORKSPACE_ID_PREFIX}gateway-session-1`,
        name: "Scoped Temp",
        path: path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME, "gateway-session-1"),
        permissions: {},
      },
    ]);
    (router as Any).sessionManager.updateSessionContext = vi.fn();

    const adapter = {
      type: "whatsapp",
      sendMessage: vi.fn().mockResolvedValue("msg-1"),
    } as Any;

    await (router as Any).handleWorkspacesCommand(
      adapter,
      {
        chatId: "chat-1",
        messageId: "incoming-1",
      },
      "session-1",
    );

    const text = adapter.sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain("Real Workspace");
    expect(text).not.toContain("Temporary Workspace");
    expect(text).not.toContain("Scoped Temp");
    expect(text).not.toContain(TEMP_WORKSPACE_ROOT_DIR_NAME);
  });
});
