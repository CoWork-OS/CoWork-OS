import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalPreviewProcessService,
  type LocalPreviewProcessServiceDeps,
} from "../LocalPreviewProcessService";

const testServerScript = [
  "const http = require('node:http');",
  "console.log('token=super-secret');",
  "console.log('preview-env=' + (process.env.COWORK_PREVIEW_TEST_SECRET || 'absent'));",
  "http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');",
].join(" ");

const testTemplate = {
  id: "npm-dev" as const,
  label: "test server",
  executable: process.execPath,
  args: ["-e", testServerScript, "${PORT}"],
  description: "Test-only loopback server.",
};

describe("LocalPreviewProcessService", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((action) => action()));
  });

  it("starts, health-checks, streams redacted logs, restarts, and revokes the exact URL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-local-preview-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const allowed: string[] = [];
    const revoked: string[] = [];
    const previousSecret = process.env.COWORK_PREVIEW_TEST_SECRET;
    process.env.COWORK_PREVIEW_TEST_SECRET = "must-not-cross-preview-boundary";
    const deps: LocalPreviewProcessServiceDeps = {
      templates: [testTemplate],
      allowLocalPreviewUrl: (url) => allowed.push(url),
      revokeLocalPreviewUrl: (url) => revoked.push(url),
    };
    const service = new LocalPreviewProcessService(deps);

    const started = await service.start({
      taskId: "task-1",
      workspaceId: "workspace-1",
      workspacePath: root,
      templateId: "npm-dev",
      healthPath: "/health",
    });

    expect(started.status).toBe("ready");
    expect(started.host).toBe("127.0.0.1");
    expect(started.port).toBeGreaterThanOrEqual(1024);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}/`);
    expect((await service.health(started.id)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.get(started.id)?.logs.join("\n")).toContain("token=[REDACTED]");
    expect(service.get(started.id)?.logs.join("\n")).toContain("preview-env=absent");
    expect(allowed).toEqual([started.url]);

    await expect(
      service.start({
        taskId: "task-1",
        workspaceId: "workspace-1",
        workspacePath: root,
        templateId: "npm-dev",
      }),
    ).rejects.toThrow("already running");

    const restarted = await service.restart(started.id);
    expect(restarted.id).not.toBe(started.id);
    expect(restarted.status).toBe("ready");
    await service.stop(restarted.id);
    if (previousSecret === undefined) delete process.env.COWORK_PREVIEW_TEST_SECRET;
    else process.env.COWORK_PREVIEW_TEST_SECRET = previousSecret;
    expect(service.get(restarted.id)?.status).toBe("stopped");
    expect(revoked).toContain(started.url);
    expect(revoked).toContain(restarted.url);
  }, 20_000);

  it("rejects a working directory outside the workspace and invalid ports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-local-preview-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-local-preview-outside-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    cleanup.push(() => fs.rm(outside, { recursive: true, force: true }));
    const service = new LocalPreviewProcessService({ templates: [testTemplate] });

    await expect(
      service.start({
        taskId: "task-1",
        workspaceId: "workspace-1",
        workspacePath: root,
        workingDirectory: outside,
        templateId: "npm-dev",
      }),
    ).rejects.toThrow("must stay within the workspace");
    await expect(
      service.start({
        taskId: "task-1",
        workspaceId: "workspace-1",
        workspacePath: root,
        templateId: "npm-dev",
        port: 80,
      }),
    ).rejects.toThrow("between 1024 and 65535");
  });
});
