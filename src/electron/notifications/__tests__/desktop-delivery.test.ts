import { afterEach, describe, expect, it, vi } from "vitest";
import { showDesktopNotification } from "../desktop-delivery";

const mocks = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("../NativeNotificationCenter", () => ({
  NativeNotificationCenter: { getInstance: () => ({ show: mocks.native }) },
}));
const notification = { id: "test", title: "TEST DATA", message: "Preview" };

afterEach(() => {
  vi.clearAllMocks();
});

describe("desktop notification delivery", () => {
  it("delivers through the system notification center only", () => {
    mocks.native.mockReturnValue(true);
    expect(showDesktopNotification(notification)).toBe(true);
    expect(mocks.native).toHaveBeenCalledExactlyOnceWith(notification);
  });

  it("reports a declined native delivery instead of drawing its own banner", () => {
    mocks.native.mockReturnValue(false);
    expect(showDesktopNotification(notification)).toBe(false);
    expect(mocks.native).toHaveBeenCalledOnce();
  });
});
