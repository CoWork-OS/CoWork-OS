import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let stored: unknown;
  return {
    get stored() {
      return stored;
    },
    set stored(value: unknown) {
      stored = value;
    },
    save: vi.fn((_category: string, value: unknown) => {
      stored = value;
      return true;
    }),
    load: vi.fn(() => stored),
  };
});

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({ save: mocks.save, load: mocks.load }),
  },
}));

import {
  CamofoxSettingsManager,
  resolveCamofoxOrigin,
  validateCamofoxProxyPort,
} from "../camofox-settings";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  CAMOFOX_LOOPBACK_PLUGIN_PATH,
  CAMOFOX_LOOPBACK_PLUGIN_SOURCE,
  camofoxStartCommand,
} from "../../../../shared/camofox";

beforeEach(() => {
  mocks.stored = undefined;
  mocks.save.mockClear();
  CamofoxSettingsManager.clearCache();
});

describe("resolveCamofoxOrigin", () => {
  it("accepts loopback origins only", () => {
    expect(resolveCamofoxOrigin("http://127.0.0.1:9377/")).toBe("http://127.0.0.1:9377");
    expect(resolveCamofoxOrigin("http://[::1]:9377")).toBe("http://[::1]:9377");
  });

  it("refuses names, network hosts, lookalikes, https, credentials and paths", () => {
    // A name is resolved, so even localhost could point elsewhere.
    expect(() => resolveCamofoxOrigin("http://localhost:9377")).toThrow(/this Mac/);
    expect(() => resolveCamofoxOrigin("http://192.168.1.20:9377")).toThrow(/this Mac/);
    expect(() => resolveCamofoxOrigin("http://0.0.0.0:9377")).toThrow(/this Mac/);
    expect(() => resolveCamofoxOrigin("http://127.0.0.1.nip.io:9377")).toThrow(/this Mac/);
    expect(() => resolveCamofoxOrigin("http://camofox.localhost:9377")).toThrow(/this Mac/);
    expect(() => resolveCamofoxOrigin("https://127.0.0.1:9377")).toThrow(/http:\/\//);
    expect(() => resolveCamofoxOrigin("http://user:pw@127.0.0.1:9377")).toThrow(/credentials/);
    expect(() => resolveCamofoxOrigin("http://127.0.0.1:9377/api")).toThrow(/origin/);
    expect(() => resolveCamofoxOrigin("not a url")).toThrow(/valid URL/);
  });
});

describe("validateCamofoxProxyPort", () => {
  it("needs a non-privileged port that is not the server's", () => {
    expect(validateCamofoxProxyPort(9378, "http://127.0.0.1:9377")).toBe(9378);
    expect(() => validateCamofoxProxyPort(80, "http://127.0.0.1:9377")).toThrow(/1024/);
    expect(() => validateCamofoxProxyPort(9377.5, "http://127.0.0.1:9377")).toThrow(/1024/);
    expect(() => validateCamofoxProxyPort(9377, "http://127.0.0.1:9377")).toThrow(/differ/);
  });
});

describe("CamofoxSettingsManager", () => {
  it("is off by default and keeps keys out of the display settings", () => {
    expect(CamofoxSettingsManager.loadEnabled()).toBeNull();
    CamofoxSettingsManager.save({ enabled: true, accessKey: " access ", apiKey: "api-key" });
    expect(mocks.save).toHaveBeenCalledWith("camofox", {
      enabled: true,
      serverUrl: "http://127.0.0.1:9377",
      proxyPort: 9378,
      persistentIdentity: false,
      accessKey: "access",
      apiKey: "api-key",
      proxyPassword: expect.stringMatching(/^[0-9a-f]{48}$/),
    });
    const display = CamofoxSettingsManager.getDisplaySettings();
    expect(display).toEqual({
      enabled: true,
      serverUrl: "http://127.0.0.1:9377",
      proxyPort: 9378,
      persistentIdentity: false,
      accessKeyConfigured: true,
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(display)).not.toContain('access"');
    expect(JSON.stringify(display)).not.toContain(CamofoxSettingsManager.load().proxyPassword);
    expect(CamofoxSettingsManager.loadEnabled()?.origin).toBe("http://127.0.0.1:9377");
  });

  it("drops stored keys when the server origin changes and clears them on null", () => {
    CamofoxSettingsManager.save({ enabled: true, accessKey: "access", apiKey: "api" });
    // The key does not carry to the new origin, and an enabled Camofox needs one.
    expect(() => CamofoxSettingsManager.save({ serverUrl: "http://127.0.0.1:9400" })).toThrow(
      /access key/,
    );
    CamofoxSettingsManager.save({ enabled: false, serverUrl: "http://127.0.0.1:9400" });
    expect(CamofoxSettingsManager.load().accessKey).toBeUndefined();
    expect(CamofoxSettingsManager.load().apiKey).toBeUndefined();
    CamofoxSettingsManager.save({ accessKey: "again" });
    CamofoxSettingsManager.save({ persistentIdentity: true });
    expect(CamofoxSettingsManager.load().accessKey).toBe("again");
    CamofoxSettingsManager.save({ accessKey: null });
    expect(CamofoxSettingsManager.load().accessKey).toBeUndefined();
  });

  it("keeps one proxy password across server changes and fills it in only on request", () => {
    CamofoxSettingsManager.save({ enabled: true, accessKey: "access" });
    const password = CamofoxSettingsManager.load().proxyPassword!;
    CamofoxSettingsManager.save({ enabled: false, serverUrl: "http://127.0.0.1:9400" });
    expect(CamofoxSettingsManager.load().proxyPassword).toBe(password);
    expect(CamofoxSettingsManager.startCommandWithProxyPassword()).toContain(
      `PROXY_USERNAME=cowork PROXY_PASSWORD=${password} `,
    );
    expect(camofoxStartCommand("http://127.0.0.1:9400", 9378)).not.toContain(password);
  });

  it("makes a proxy password when the start command is copied before any save", () => {
    expect(CamofoxSettingsManager.startCommandWithProxyPassword()).toMatch(
      /PROXY_PASSWORD=[0-9a-f]{48} /,
    );
  });

  it("refuses to save a server off this Mac", () => {
    expect(() =>
      CamofoxSettingsManager.save({ enabled: true, serverUrl: "http://10.0.0.5:9377" }),
    ).toThrow(/this Mac/);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("treats a stored non-loopback URL as not configured", () => {
    mocks.stored = { enabled: true, serverUrl: "http://10.0.0.5:9377", proxyPort: 9378 };
    CamofoxSettingsManager.clearCache();
    expect(CamofoxSettingsManager.loadEnabled()).toBeNull();
  });
});

describe("camofoxStartCommand", () => {
  it("binds Camofox to loopback, requires the access key and points it at the policy proxy", () => {
    expect(camofoxStartCommand("http://127.0.0.1:9400", 9411)).toBe(
      "CAMOFOX_BIND_HOST=127.0.0.1 CAMOFOX_PORT=9400 CAMOFOX_ACCESS_KEY=<your access key> " +
        "PROXY_HOST=127.0.0.1 PROXY_PORT=9411 PROXY_USERNAME=cowork " +
        "PROXY_PASSWORD=<proxy password> npm start",
    );
  });
});

describe("Camofox loopback plugin", () => {
  it("turns on proxying for loopback at every browser launch, keeping Camofox's own prefs", async () => {
    // Loaded the way Camofox loads plugins: an ES module file with a register(app, ctx) export.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camofox-plugin-"));
    try {
      const file = path.join(dir, path.basename(CAMOFOX_LOOPBACK_PLUGIN_PATH, ".js") + ".mjs");
      await fs.writeFile(file, CAMOFOX_LOOPBACK_PLUGIN_SOURCE);
      const plugin = (await import(pathToFileURL(file).href)) as {
        register(app: unknown, ctx: { events: EventEmitter }): void;
      };
      const events = new EventEmitter();
      plugin.register({}, { events });

      const options: { firefoxUserPrefs?: Record<string, unknown> } = {
        firefoxUserPrefs: { "network.dns.disableIPv6": true },
      };
      events.emit("browser:launching", { options });
      expect(options.firefoxUserPrefs).toEqual({
        "network.dns.disableIPv6": true,
        "network.proxy.allow_hijacking_localhost": true,
      });

      const bare: { firefoxUserPrefs?: Record<string, unknown> } = {};
      events.emit("browser:launching", { options: bare });
      expect(bare.firefoxUserPrefs).toEqual({ "network.proxy.allow_hijacking_localhost": true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
