import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { BrowserUploadQuota } from "../browser-upload-quota";

const ampleSpace = async () => 100n * 1024n * 1024n * 1024n;

describe("BrowserUploadQuota durable accounting", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-quota-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function quota(overrides = {}) {
    return new BrowserUploadQuota({ uploadQuotaDirectory: directory, ...overrides });
  }

  it("shares workspace bytes across profiles and profile bytes across workspaces", async () => {
    const options = { maxWorkspaceCommittedUploadBytes: 4, maxProfileCommittedUploadBytes: 4 };
    const first = quota(options);
    await first.settle(await first.reserve("profile-a", "workspace-a", 4, ampleSpace), 4);
    await expect(
      quota(options).reserve("profile-b", "workspace-a", 1, ampleSpace),
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      quota(options).reserve("profile-a", "workspace-b", 1, ampleSpace),
    ).rejects.toMatchObject({ statusCode: 429 });
    const other = quota(options);
    await other.settle(await other.reserve("profile-b", "workspace-b", 4, ampleSpace), 4);
  });

  it("bounds total bytes and file count across otherwise independent profiles and workspaces", async () => {
    const options = { maxCommittedUploadBytes: 4, maxCommittedUploadFiles: 2 };
    const first = quota(options);
    await first.settle(await first.reserve("a", "a", 4, ampleSpace), 4);
    await expect(quota(options).reserve("b", "b", 1, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
    });
    await first.settle(await first.reserve("b", "b", 0, ampleSpace), 0);
    await expect(quota(options).reserve("c", "c", 0, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("retains interrupted reservations on restart and only refunds explicitly cleaned failures", async () => {
    const limits = { maxCommittedUploadBytes: 4 };
    const first = quota(limits);
    const reservation = await first.reserve("a", "a", 4, ampleSpace);
    await expect(quota(limits).reserve("a", "a", 1, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
    });
    await first.settle(reservation, null);
    const next = await quota(limits).reserve("a", "a", 4, ampleSpace);
    await quota(limits).settle(next, 2);
    await quota(limits).reserve("a", "a", 2, ampleSpace);
  });

  it("does not reset a profile rate limit on restart or a new workspace", async () => {
    const limits = { maxProfileUploadsPerMinute: 1 };
    const first = quota(limits);
    await first.settle(await first.reserve("a", "a", 0, ampleSpace), 0);
    await expect(quota(limits).reserve("a", "b", 0, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
      retryable: true,
    });
    const other = quota(limits);
    await other.settle(await other.reserve("b", "a", 0, ampleSpace), 0);
  });

  it("never refunds twice after an ambiguous settlement while another upload is pending", async () => {
    let failFlush = false;
    const limits = { uploadQuotaDirectory: directory, maxCommittedUploadBytes: 192 };
    const files = new (class extends BrowserUploadQuota {
      protected override async flushLedgerDirectory() {
        if (failFlush) throw new Error("Directory sync EIO");
        await super.flushLedgerDirectory();
      }
    })(limits);
    await files.settle(await files.reserve("a", "a", 64, ampleSpace), 64);
    const first = await files.reserve("a", "a", 64, ampleSpace);
    const second = await files.reserve("a", "a", 64, ampleSpace);
    failFlush = true;
    await expect(files.settle(first, 2)).rejects.toThrow("Directory sync EIO");
    await expect(files.settle(first, null)).rejects.toThrow("already settled");
    await expect(quota(limits).reserve("a", "a", 64, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
    });
    failFlush = false;
    await files.settle(second, 64);
    const ledger = JSON.parse(await fs.readFile(path.join(directory, "quota.json"), "utf8"));
    expect(ledger.total).toMatchObject({ bytes: 130, files: 3 });
    expect(ledger.pendingBytes).toBe(0);
  });

  it("preserves a free-space reserve including pending uploads across services", async () => {
    const options = { minUploadFreeBytes: 100 };
    await quota(options).reserve("a", "a", 4, async () => 104n);
    await expect(quota(options).reserve("b", "b", 1, async () => 104n)).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(quota(options).assertFreeSpace(async () => 0n, 0)).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      quota(options).reserve("a", "a", 1, async () => {
        throw new Error("Disk unavailable");
      }),
    ).rejects.toThrow("Disk unavailable");
  });

  it.each([
    "invalid json",
    '{"version":2}',
    JSON.stringify({
      version: 1,
      total: { bytes: 1, files: 1, attempts: 0, windowStart: 0 },
      pendingBytes: 0,
      profiles: {},
      workspaces: {},
    }),
  ])("fails closed for corrupt quota state: %s", async (data) => {
    await fs.writeFile(path.join(directory, "quota.json"), data);
    await expect(quota().reserve("a", "a", 1, ampleSpace)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, "quota.json"), "utf8")).toBe(data);
  });

  it("does not steal an abandoned accounting lock or reset the ledger", async () => {
    await fs.writeFile(path.join(directory, "quota.lock"), "abandoned");
    await expect(quota().reserve("a", "a", 1, ampleSpace)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(await fs.readFile(path.join(directory, "quota.lock"), "utf8")).toBe("abandoned");
  });

  it("serializes admissions from real independent processes sharing a data root", async () => {
    const workerPath = path.join(directory, "worker.cjs");
    await build({
      stdin: {
        contents: `import { BrowserUploadQuota } from ${JSON.stringify(path.resolve("src/host/services/browser-upload-quota.ts"))};
          const quota = new BrowserUploadQuota({ uploadQuotaDirectory: process.argv[2], maxCommittedUploadBytes: 4 });
          process.stdout.write("ready\\n");
          process.stdin.once("data", async () => {
            try { await quota.reserve(process.argv[3], process.argv[3], 4, async () => 100000000000n); process.stdout.write("accepted\\n"); }
            catch (error) { process.stdout.write(String(error.statusCode) + "\\n"); }
            process.stdin.destroy();
          });`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerPath,
    });
    const children = ["a", "b"].map((id) =>
      spawn(process.execPath, [workerPath, directory, id], { stdio: ["pipe", "pipe", "pipe"] }),
    );
    const results = children.map(
      (child) =>
        new Promise<string>((resolve, reject) => {
          let output = "";
          child.stdout.on("data", (data) => {
            output += data.toString();
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0
              ? resolve(output.trim().split("\n").at(-1)!)
              : reject(new Error(`Worker exited ${code}`)),
          );
        }),
    );
    try {
      await Promise.all(
        children.map(
          (child) => new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
        ),
      );
      children.forEach((child) => child.stdin.end("go"));
      expect((await Promise.all(results)).sort()).toEqual(["429", "accepted"]);
      await expect(
        quota({ maxCommittedUploadBytes: 4 }).reserve("c", "c", 1, ampleSpace),
      ).rejects.toMatchObject({ statusCode: 429 });
    } finally {
      children.forEach((child) => child.kill());
    }
  });
});
