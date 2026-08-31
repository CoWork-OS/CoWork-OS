import { describe, expect, it, vi } from "vitest";
import { BrowserWorkbenchService } from "../browser-workbench-service";

describe("BrowserWorkbenchService local preview URL policy", () => {
  it("allows only local HTML URLs explicitly opened by the workbench", () => {
    const service = new BrowserWorkbenchService({ allowLocalPreviewUrl: vi.fn() } as Any);
    const previewUrl = "file:///tmp/generated%20preview.html";

    expect(service.isAllowedLocalPreviewUrl(previewUrl)).toBe(false);

    service.allowLocalPreviewUrl(previewUrl);
    expect(service.isAllowedLocalPreviewUrl(previewUrl)).toBe(true);
    expect(service.isAllowedLocalPreviewUrl("file:///tmp/other.html")).toBe(false);
    expect(service.isAllowedLocalPreviewUrl("file:///tmp/generated%20preview.pdf")).toBe(false);
  });

  it("forwards the complete network profile to visible browser sessions", () => {
    const browserSessionManager = { setAccessPolicy: vi.fn() };
    const service = new BrowserWorkbenchService(browserSessionManager as Any);

    service.setAccessPolicy({
      taskId: "task-1",
      sessionId: "session-1",
      networkEnabled: true,
      accessNetworkMode: "disabled",
      profileDomainRules: [{ pattern: "example.com", access: "allow" }],
    });

    expect(browserSessionManager.setAccessPolicy).toHaveBeenCalledWith(
      "task-1",
      {
        networkEnabled: true,
        accessNetworkMode: "disabled",
        profileDomainRules: [{ pattern: "example.com", access: "allow" }],
      },
      "session-1",
    );
  });
});
