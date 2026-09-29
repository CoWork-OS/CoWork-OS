import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebHostIdentity } from "../host-identity";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser host identity", () => {
  it("persists a separate opaque installation ID and rotates generation on restart", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "cowork-web-host-"));
    directories.push(userDataDir);
    const options = {
      userDataDir,
      profileId: "default",
      runtime: "node" as const,
      appVersion: "test",
    };

    const first = await createWebHostIdentity(options);
    const second = await createWebHostIdentity(options);

    expect(second.installationId).toBe(first.installationId);
    expect(second.generation).not.toBe(first.generation);
    expect(second.profileId).toBe("default");
    expect((await readFile(path.join(userDataDir, ".cowork-web-host-id"), "utf8")).trim()).toBe(
      first.installationId,
    );
    if (process.platform !== "win32") {
      expect((await stat(path.join(userDataDir, ".cowork-web-host-id"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects an invalid persisted ID instead of silently changing browser identity", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "cowork-web-host-"));
    directories.push(userDataDir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(userDataDir, ".cowork-web-host-id"), "invalid\n");

    await expect(
      createWebHostIdentity({
        userDataDir,
        profileId: "default",
        runtime: "node",
        appVersion: "test",
      }),
    ).rejects.toThrow("Invalid browser host identity file");
  });
});
