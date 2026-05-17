import { beforeEach, describe, expect, it, vi } from "vitest";

type NotificationEventName = "click" | "close" | "failed";
type NotificationHandler = () => void;

const mockState = vi.hoisted(() => ({
  isSupported: true,
  shouldThrow: false,
  instances: [] as Array<{
    options: Record<string, unknown>;
    show: ReturnType<typeof vi.fn>;
    handlers: Partial<Record<NotificationEventName, NotificationHandler>>;
    emit: (event: NotificationEventName) => void;
  }>,
}));

vi.mock("electron", () => {
  const mockIcon = { isEmpty: () => false };

  class MockNotification {
    static isSupported = vi.fn(() => mockState.isSupported);
    private readonly instance: (typeof mockState.instances)[number];

    constructor(options: Record<string, unknown>) {
      if (mockState.shouldThrow) {
        throw new Error("native notification failed");
      }
      const handlers: Partial<Record<NotificationEventName, NotificationHandler>> = {};
      this.instance = {
        options,
        show: vi.fn(),
        handlers,
        emit: (event: NotificationEventName) => handlers[event]?.(),
      };
      mockState.instances.push(this.instance);
    }

    on(event: NotificationEventName, handler: NotificationHandler): this {
      this.instance.handlers[event] = handler;
      return this;
    }

    show(): void {
      this.instance.show();
    }
  }
  return {
    app: {
      getAppPath: () => "/app",
    },
    nativeImage: {
      createFromPath: vi.fn(() => mockIcon),
    },
    Notification: MockNotification,
  };
});

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn((filePath: string) => filePath === "/app/build/icon.png"),
  },
}));

async function loadNotificationCenter() {
  const mod = await import("../NativeNotificationCenter");
  return mod.NativeNotificationCenter.getInstance();
}

describe("NativeNotificationCenter", () => {
  beforeEach(() => {
    vi.resetModules();
    mockState.isSupported = true;
    mockState.shouldThrow = false;
    mockState.instances = [];
  });

  it("returns false when native notifications are not supported", async () => {
    mockState.isSupported = false;
    const center = await loadNotificationCenter();

    const result = center.show({
      id: "n1",
      title: "Title",
      message: "Message",
      taskId: "task-1",
    });

    expect(result).toBe(false);
    expect(mockState.instances).toHaveLength(0);
  });

  it("shows a native notification and forwards clicks with the task id", async () => {
    const onClick = vi.fn();
    const center = await loadNotificationCenter();
    center.setOnClick(onClick);

    const result = center.show({
      id: "n1",
      title: "Task complete",
      message: "Report finished",
      taskId: "task-1",
    });

    expect(result).toBe(true);
    expect(mockState.instances[0]?.options).toMatchObject({
      title: "Task complete",
      body: "Report finished",
      icon: expect.any(Object),
      timeoutType: "default",
    });
    expect(mockState.instances[0]?.show).toHaveBeenCalledOnce();

    mockState.instances[0]?.emit("click");

    expect(onClick).toHaveBeenCalledWith("n1", "task-1");
  });

  it("returns false when creating the native notification fails", async () => {
    mockState.shouldThrow = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const center = await loadNotificationCenter();

    const result = center.show({
      id: "n1",
      title: "Title",
      message: "Message",
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[Notifications] Native notification failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
