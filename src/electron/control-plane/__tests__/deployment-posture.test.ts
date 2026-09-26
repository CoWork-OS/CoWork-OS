import { describe, expect, it } from "vitest";
import { evaluateControlPlaneDeploymentPosture } from "../deployment-posture";
import type { ControlPlaneSettings } from "../settings";

const settings = (overrides: Partial<ControlPlaneSettings> = {}) =>
  ({
    host: "127.0.0.1",
    token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    tailscale: { mode: "off", resetOnExit: true },
    ...overrides,
  }) as ControlPlaneSettings;

describe("evaluateControlPlaneDeploymentPosture", () => {
  it("allows loopback managed deployments", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings(),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("ready");
    expect(posture.publicBind).toBe(false);
  });

  it("allows public bind when Tailscale exposure is enabled", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings({ host: "0.0.0.0", tailscale: { mode: "serve", resetOnExit: true } }),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("degraded");
    expect(posture.tailscaleEnabled).toBe(true);
  });

  it("allows public bind inside a container context", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings({ host: "0.0.0.0" }),
      headless: true,
      managedDeployment: true,
      bindContext: "container",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("degraded");
    expect(posture.bindContext).toBe("container");
  });

  it("blocks public bind in managed host mode by default", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings({ host: "0.0.0.0" }),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("blocked");
  });

  it("allows public bind with explicit break-glass override", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings({ host: "::" }),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: true,
    });

    expect(posture.status).toBe("degraded");
    expect(posture.insecurePublicBindAllowed).toBe(true);
  });

  it("blocks weak tokens in managed mode", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings({ token: "test-token" }),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("blocked");
    expect(posture.operatorTokenStrong).toBe(false);
  });

  it("does not block upgraded deployments that no longer store a mobile companion token", () => {
    const posture = evaluateControlPlaneDeploymentPosture({
      settings: settings(),
      headless: true,
      managedDeployment: true,
      bindContext: "host",
      allowInsecurePublicBind: false,
    });

    expect(posture.status).toBe("ready");
    expect(posture).not.toHaveProperty("nodeTokenStrong");
  });
});
