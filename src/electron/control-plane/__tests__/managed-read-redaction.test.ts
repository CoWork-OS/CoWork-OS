import { describe, expect, it } from "vitest";
import {
  redactManagedEnvironmentForRead,
  redactObjectSecrets,
  sanitizeManagedEnvironmentCreateParams,
} from "../handlers";

describe("redactManagedEnvironmentForRead", () => {
  it("removes sensitive linkage metadata from renderer-facing config", () => {
    const environment = {
      id: "env-1",
      name: "Test env",
      config: {
        workspaceId: "workspace-1",
        enableShell: true,
        credentialRefs: ["cred-1"],
        managedAccountRefs: ["acct-1"],
      },
    };

    const redacted = redactManagedEnvironmentForRead(environment);

    expect(redacted.config.workspaceId).toBe("workspace-1");
    expect(redacted.config.enableShell).toBe(true);
    expect(redacted.config.credentialRefs).toBeUndefined();
    expect(redacted.config.managedAccountRefs).toBeUndefined();
  });

  it("does not mutate the stored environment object", () => {
    const environment = {
      id: "env-1",
      name: "Test env",
      config: {
        workspaceId: "workspace-1",
        credentialRefs: ["cred-1"],
        managedAccountRefs: ["acct-1"],
      },
    };

    const redacted = redactManagedEnvironmentForRead(environment);

    expect(redacted).not.toBe(environment);
    expect(redacted.config).not.toBe(environment.config);
    expect(environment.config.credentialRefs).toEqual(["cred-1"]);
    expect(environment.config.managedAccountRefs).toEqual(["acct-1"]);
  });
});

describe("sanitizeManagedEnvironmentCreateParams", () => {
  it("accepts file path allowlists in managed environment config", () => {
    const sanitized = sanitizeManagedEnvironmentCreateParams({
      name: "Test env",
      config: {
        workspaceId: "workspace-1",
        filePaths: ["docs/runbook.md", "src/index.ts"],
      },
    });

    expect(sanitized.config.filePaths).toEqual(["docs/runbook.md", "src/index.ts"]);
  });

  it("rejects non-string file path entries", () => {
    expect(() =>
      sanitizeManagedEnvironmentCreateParams({
        name: "Test env",
        config: {
          workspaceId: "workspace-1",
          filePaths: ["docs/runbook.md", 123],
        },
      }),
    ).toThrow();
  });
});

describe("redactObjectSecrets on control-plane settings", () => {
  // Shape of ControlPlaneSettings as returned by loadSettingsWithSecrets().
  // `config.get` is gated at `read` scope, which companion "node" clients hold,
  // so none of these values may appear in its response.
  const settings = {
    enabled: true,
    host: "127.0.0.1",
    port: 18789,
    token: "admin-token-value",
    nodeToken: "node-token-value",
    remote: {
      url: "ws://host:18789",
      token: "remote-token-value",
      deviceName: "My Device",
    },
    savedRemoteDevices: [{ id: "d1", config: { token: "saved-device-token" } }],
    managedDevices: [{ id: "m1", config: { token: "managed-device-token" } }],
  };

  it("masks every credential in the settings payload", () => {
    const redacted = redactObjectSecrets(settings) as typeof settings;

    expect(redacted.token).not.toBe("admin-token-value");
    expect(redacted.nodeToken).not.toBe("node-token-value");
    expect(redacted.remote.token).not.toBe("remote-token-value");
    expect(redacted.savedRemoteDevices[0].config.token).not.toBe("saved-device-token");
    expect(redacted.managedDevices[0].config.token).not.toBe("managed-device-token");
  });

  it("leaves non-secret connection fields readable", () => {
    const redacted = redactObjectSecrets(settings) as typeof settings;

    expect(redacted.enabled).toBe(true);
    expect(redacted.host).toBe("127.0.0.1");
    expect(redacted.port).toBe(18789);
    expect(redacted.remote.url).toBe("ws://host:18789");
    expect(redacted.remote.deviceName).toBe("My Device");
  });

  it("leaks no raw token anywhere in the serialized payload", () => {
    // Catches any future field added to the settings shape.
    const serialized = JSON.stringify(redactObjectSecrets(settings));

    for (const secret of [
      "admin-token-value",
      "node-token-value",
      "remote-token-value",
      "saved-device-token",
      "managed-device-token",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not mutate the stored settings object", () => {
    redactObjectSecrets(settings);

    expect(settings.token).toBe("admin-token-value");
    expect(settings.remote.token).toBe("remote-token-value");
  });
});
