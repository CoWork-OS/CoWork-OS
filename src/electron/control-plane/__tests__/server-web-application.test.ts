import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_CAPABILITIES,
  WEB_API_PATH,
  type HostCapabilities,
} from "../../../shared/host-api/contracts";
import { WebApplication } from "../../../host/web/WebApplication";
import { ControlPlaneServer } from "../server";

describe("Control Plane browser application mount", () => {
  let server: ControlPlaneServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("attaches after startup while preserving native UI, health, and root WebSocket challenge", async () => {
    server = new ControlPlaneServer({
      token: "native-control-plane-token",
      port: 0,
      host: "127.0.0.1",
    });
    await server.start();
    const port = server.getAddress()?.port;
    expect(port).toBeGreaterThan(0);

    const beforeEnable = await fetch(`http://127.0.0.1:${port}${WEB_API_PATH}/bootstrap`);
    expect(beforeEnable.status).toBe(404);

    const capabilities = Object.fromEntries(
      HOST_CAPABILITIES.map((name) => [name, { available: true }]),
    ) as HostCapabilities;
    const app = new WebApplication({
      enabled: true,
      webDirectory: "/tmp/cowork-web-unbuilt-fixture",
      deployment: { mode: "loopback" },
      getHostIdentity: () => ({
        installationId: "opaque-installation",
        profileId: "profile-1",
        generation: "run-1",
        runtime: "node",
        platform: "linux",
        appVersion: "1.0.0",
      }),
      getCapabilities: async () => capabilities,
      getSessionBootstrap: async () => ({
        providerReady: false,
        onboardingCompleted: false,
        disclaimerAccepted: false,
        activeWorkspaceId: null,
      }),
    });
    await server.setWebApplication(app);

    const [bootstrap, ui, health] = await Promise.all([
      fetch(`http://127.0.0.1:${port}${WEB_API_PATH}/bootstrap`),
      fetch(`http://127.0.0.1:${port}/ui`),
      fetch(`http://127.0.0.1:${port}/health`),
    ]);
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({ apiVersion: 1, authentication: "required" });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("Control Plane");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const nativeSocket = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const nativeChallenge = await new Promise<string>((resolve, reject) => {
      nativeSocket.once("message", (data) => resolve(data.toString()));
      nativeSocket.once("error", reject);
    });
    expect(JSON.parse(nativeChallenge)).toMatchObject({ event: "connect.challenge" });
    nativeSocket.close();
  });

  it("rejects a web-ticket upgrade on the browser path without pairing or a ticket", async () => {
    server = new ControlPlaneServer({
      token: "native-control-plane-token",
      port: 0,
      host: "127.0.0.1",
    });
    await server.start();
    const port = server.getAddress()?.port;
    const app = new WebApplication({
      enabled: true,
      webDirectory: "/tmp/cowork-web-unbuilt-fixture",
      deployment: { mode: "loopback" },
      getHostIdentity: () => ({
        installationId: "opaque-installation",
        profileId: "profile-1",
        generation: "run-1",
        runtime: "node",
        platform: "linux",
        appVersion: "1.0.0",
      }),
      getCapabilities: async () => ({}) as HostCapabilities,
      getSessionBootstrap: async () => ({
        providerReady: false,
        onboardingCompleted: false,
        disclaimerAccepted: false,
        activeWorkspaceId: null,
      }),
    });
    await server.setWebApplication(app);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${WEB_API_PATH}/ws`,
      ["cowork-web-v1", "cowork-ticket.not-a-valid-ticket"],
      {
        headers: { Origin: `http://127.0.0.1:${port}` },
      },
    );
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => reject(new Error("Unauthenticated browser socket was accepted")));
      socket.once("error", (error) => {
        if (!socket.listenerCount("unexpected-response")) reject(error);
      });
    });
    expect(status).toBe(401);
  });
});
