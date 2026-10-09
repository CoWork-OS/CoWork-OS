import { describe, expect, it, vi } from "vitest";
vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: { isInitialized: () => false },
}));
import {
  BrowserPermissionManager,
  type BrowserPermissionPrompt,
  type BrowserPermissionStore,
  classifyBrowserPermission,
  permissionKeysFor,
} from "../browser-permissions";

const PARTITION = "persist:cowork-browser-ws";

function memoryStore(): BrowserPermissionStore & { saved: unknown[] } {
  let value: Any;
  const saved: unknown[] = [];
  return {
    saved,
    load: () => value,
    save: (next) => {
      value = JSON.parse(JSON.stringify(next));
      saved.push(value);
    },
  };
}

function setup(options: { owned?: boolean; forcedDeny?: string[] } = {}) {
  const prompts: BrowserPermissionPrompt[] = [];
  const store = memoryStore();
  const manager = new BrowserPermissionManager({
    resolveOwner: (id) =>
      options.owned === false || id !== 7
        ? null
        : { taskId: "t", sessionId: "default", tabId: "a" },
    sendPrompt: (prompt) => {
      prompts.push(prompt);
      return true;
    },
    store,
    isForcedDeny: (permission) => options.forcedDeny?.includes(permission) === true,
  });
  const contents = { id: 7, getURL: () => "https://maps.example/", once: vi.fn() };
  const request = (permission: string, details: Record<string, unknown> = {}) =>
    manager.handleRequest(PARTITION, contents, permission, {
      requestingUrl: "https://maps.example/route",
      ...details,
    });
  return { manager, prompts, store, contents, request };
}

describe("browser permission decisions", () => {
  it("classifies harmless, prompted and denied permissions", () => {
    expect(classifyBrowserPermission("fullscreen")).toBe("allow");
    expect(classifyBrowserPermission("clipboard-sanitized-write")).toBe("allow");
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "hid"]) {
      expect(classifyBrowserPermission(permission)).toBe("prompt");
    }
    for (const permission of ["idle-detection", "background-sync", "window-management", "x"]) {
      expect(classifyBrowserPermission(permission)).toBe("deny");
    }
  });

  it("splits media requests into camera and microphone", () => {
    expect(permissionKeysFor("media", { mediaTypes: ["video", "audio"] })).toEqual([
      "camera",
      "microphone",
    ]);
    expect(permissionKeysFor("media", { mediaType: "audio" })).toEqual(["microphone"]);
    expect(permissionKeysFor("geolocation")).toEqual(["geolocation"]);
  });

  it("grants harmless requests and denies unlisted ones without prompting", async () => {
    const { request, prompts } = setup();
    await expect(request("fullscreen")).resolves.toBe(true);
    await expect(request("idle-detection")).resolves.toBe(false);
    expect(prompts).toEqual([]);
  });

  it("prompts in the owning tab and remembers Never allow", async () => {
    const { manager, request, prompts } = setup();
    const pending = request("geolocation");
    expect(prompts).toEqual([
      expect.objectContaining({
        tabId: "a",
        origin: "https://maps.example",
        permissions: ["geolocation"],
      }),
    ]);
    expect(manager.respond(prompts[0].requestId, "block")).toBe(true);
    await expect(pending).resolves.toBe(false);

    // Blocked is remembered: no second prompt.
    await expect(request("geolocation")).resolves.toBe(false);
    expect(prompts).toHaveLength(1);
    expect(manager.getStored(PARTITION, "https://maps.example", "geolocation")).toBe("block");
  });

  it("remembers Always allow and answers permission checks from it", async () => {
    const { manager, request, prompts, contents } = setup();
    const pending = request("media", { mediaTypes: ["video"] });
    manager.respond(prompts[0].requestId, "allow-always");
    await expect(pending).resolves.toBe(true);
    await expect(request("media", { mediaTypes: ["video"] })).resolves.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(
      manager.handleCheck(PARTITION, contents, "media", "https://maps.example", {
        mediaType: "video",
      }),
    ).toBe(true);
    expect(
      manager.handleCheck(PARTITION, contents, "media", "https://maps.example", {
        mediaType: "audio",
      }),
    ).toBe(false);
  });

  it("keeps Allow this time to the page and Dismiss unremembered", async () => {
    const { manager, request, prompts, store } = setup();
    const once = request("notifications");
    manager.respond(prompts[0].requestId, "allow-once");
    await expect(once).resolves.toBe(true);
    await expect(request("notifications")).resolves.toBe(true);
    expect(prompts).toHaveLength(1);

    const dismissed = request("clipboard-read");
    manager.respond(prompts[1].requestId, "dismiss");
    await expect(dismissed).resolves.toBe(false);
    expect(store.saved).toEqual([]);
  });

  it("asks again for every external app link, even after Always allow", async () => {
    const { manager, request, prompts, store } = setup();
    const first = request("openExternal", { externalURL: "zoommtg://join?x=1" });
    manager.respond(prompts[0].requestId, "allow-always");
    await expect(first).resolves.toBe(true);
    const second = request("openExternal", { externalURL: "otherapp://run" });
    expect(prompts).toHaveLength(2);
    manager.respond(prompts[1].requestId, "dismiss");
    await expect(second).resolves.toBe(false);
    expect(store.saved).toEqual([]);
  });

  it("denies requests from pages that are not registered workbench tabs", async () => {
    const { request, prompts } = setup({ owned: false });
    await expect(request("geolocation")).resolves.toBe(false);
    expect(prompts).toEqual([]);
  });

  it("lets an admin deny beat a stored Always allow", async () => {
    const allowed = setup();
    const first = allowed.request("geolocation");
    allowed.manager.respond(allowed.prompts[0].requestId, "allow-always");
    await first;

    const { manager, request, prompts } = setup({ forcedDeny: ["geolocation"] });
    (manager as Any).stored = (allowed.manager as Any).stored;
    await expect(request("geolocation")).resolves.toBe(false);
    expect(prompts).toEqual([]);
  });

  it("denies when no window can show the prompt and for non-web origins", async () => {
    const manager = new BrowserPermissionManager({
      resolveOwner: () => ({ taskId: "t", sessionId: "default", tabId: "a" }),
      sendPrompt: () => false,
      store: memoryStore(),
    });
    const contents = { id: 7, getURL: () => "https://maps.example/", once: vi.fn() };
    await expect(
      manager.handleRequest(PARTITION, contents, "geolocation", {
        requestingUrl: "https://maps.example/",
      }),
    ).resolves.toBe(false);
    await expect(
      manager.handleRequest(PARTITION, contents, "geolocation", {
        requestingUrl: "file:///tmp/page.html",
      }),
    ).resolves.toBe(false);
  });
});
