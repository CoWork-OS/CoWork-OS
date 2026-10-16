import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalVideoArgs,
  cancelLocalVideoJob,
  getLocalVideoJob,
  localVideoFrames,
  localVideoSize,
  resolveLocalVideoConfig,
  startLocalVideoJob,
  stopAllLocalVideoJobs,
  waitForLocalVideoJob,
} from "../local-video-provider";

let dir = "";
let python = "";
let modelDir = "";

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-video-")));
  python = path.join(dir, "python");
  modelDir = path.join(dir, "wan-mlx");
  fs.writeFileSync(python, "");
  fs.chmodSync(python, 0o755);
  fs.mkdirSync(modelDir);
});

afterEach(() => {
  // A failed test must not leave a "running" job that blocks the next one.
  stopAllLocalVideoJobs();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("resolveLocalVideoConfig", () => {
  it("reads settings first, then the environment", () => {
    expect(resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})).toMatchObject({
      pythonPath: python,
      modelDir,
    });
    expect(
      resolveLocalVideoConfig(undefined, {
        COWORK_LOCAL_VIDEO_PYTHON: python,
        COWORK_LOCAL_VIDEO_MODEL_DIR: modelDir,
      }),
    ).toMatchObject({ pythonPath: python, modelDir });
  });

  it("takes sampling steps from settings, then the environment, within 1-100", () => {
    const env = { COWORK_LOCAL_VIDEO_STEPS: "20" };
    expect(resolveLocalVideoConfig({ pythonPath: python, modelDir }, env)?.steps).toBe(20);
    expect(resolveLocalVideoConfig({ pythonPath: python, modelDir, steps: 30 }, env)?.steps).toBe(
      30,
    );
    expect(
      resolveLocalVideoConfig({ pythonPath: python, modelDir }, { COWORK_LOCAL_VIDEO_STEPS: "500" })
        ?.steps,
    ).toBeUndefined();
  });

  it("is off unless both paths exist and are absolute", () => {
    expect(resolveLocalVideoConfig(undefined, {})).toBeNull();
    expect(resolveLocalVideoConfig({ pythonPath: python }, {})).toBeNull();
    expect(resolveLocalVideoConfig({ pythonPath: "python", modelDir }, {})).toBeNull();
    expect(
      resolveLocalVideoConfig({ pythonPath: python, modelDir: path.join(dir, "missing") }, {}),
    ).toBeNull();
    // The model path must be a directory and the interpreter a file.
    expect(resolveLocalVideoConfig({ pythonPath: modelDir, modelDir: python }, {})).toBeNull();
  });

  it("only accepts an executable named like a Python interpreter", () => {
    const other = path.join(dir, "bash");
    fs.writeFileSync(other, "");
    fs.chmodSync(other, 0o755);
    expect(resolveLocalVideoConfig({ pythonPath: other, modelDir }, {})).toBeNull();
    const versioned = path.join(dir, "python3.11");
    fs.writeFileSync(versioned, "");
    fs.chmodSync(versioned, 0o755);
    expect(resolveLocalVideoConfig({ pythonPath: versioned, modelDir }, {})).not.toBeNull();
    fs.chmodSync(versioned, 0o644);
    expect(resolveLocalVideoConfig({ pythonPath: versioned, modelDir }, {})).toBeNull();
  });
});

describe("frame size and length", () => {
  it("keeps both sides divisible by 32", () => {
    for (const ratio of ["16:9", "9:16", "1:1", undefined]) {
      const { width, height } = localVideoSize(ratio);
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
    }
  });

  it("uses 4n+1 frames at 24 fps, capped", () => {
    expect(localVideoFrames(2)).toBe(49);
    expect(localVideoFrames(4)).toBe(97);
    expect(localVideoFrames(undefined)).toBe(49);
    expect(localVideoFrames(60)).toBe(121);
    for (const seconds of [1, 3, 5]) expect((localVideoFrames(seconds) - 1) % 4).toBe(0);
  });
});

describe("buildLocalVideoArgs", () => {
  it("passes the prompt as one argument and adds the reference image", () => {
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir, steps: 20 }, {})!;
    const prompt = '--seed 1 mist "drifts"; $(rm -rf /) over the river\0';
    const args = buildLocalVideoArgs({
      config,
      prompt,
      outputPath: path.join(dir, "clip.mp4"),
      referenceImagePath: path.join(dir, "scene.png"),
      duration: 2,
    });
    expect(args.slice(0, 2)).toEqual(["-m", "mlx_video.models.wan_2.generate"]);
    // One argv entry in --flag=value form: a leading "--" stays part of the value.
    expect(args).toContain('--prompt=--seed 1 mist "drifts"; $(rm -rf /) over the river');
    expect(args).toContain(`--image=${path.join(dir, "scene.png")}`);
    expect(args.some((arg) => arg.includes("\0"))).toBe(false);
    expect(args[args.indexOf("--steps") + 1]).toBe("20");
    expect(args[args.indexOf("--num-frames") + 1]).toBe("49");
  });
});

describe("local video jobs", () => {
  it("runs one render at a time and gives the child a minimal environment", () => {
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})!;
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    process.env.FAKE_PROVIDER_API_KEY = "secret";
    try {
      const { jobId } = startLocalVideoJob(
        { config, prompt: "p", outputPath: path.join(dir, "a.mp4") },
        spawnImpl as never,
      );
      const options = (spawnImpl.mock.calls[0] as unknown[])[2] as {
        env: NodeJS.ProcessEnv;
        detached: boolean;
      };
      expect(options.env.FAKE_PROVIDER_API_KEY).toBeUndefined();
      expect(options.env.HF_HUB_OFFLINE).toBe("1");
      expect(options.detached).toBe(true);
      expect((options as unknown as { cwd: string }).cwd).toBe(modelDir);
      expect(() =>
        startLocalVideoJob(
          { config, prompt: "p", outputPath: path.join(dir, "b.mp4") },
          spawnImpl as never,
        ),
      ).toThrow(/busy/);
      cancelLocalVideoJob(jobId);
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });

  it("reports success once the process exits with the output written", () => {
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})!;
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const outputPath = path.join(dir, "out", "clip.mp4");
    const { jobId } = startLocalVideoJob({ config, prompt: "p", outputPath }, spawnImpl);

    expect((spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(python);
    expect(getLocalVideoJob(jobId)?.status).toBe("running");
    fs.writeFileSync(outputPath, "mp4");
    child.emit("exit", 0);
    expect(getLocalVideoJob(jobId)).toMatchObject({ status: "succeeded", outputPath });
  });

  it("fails with the end of stderr when the model errors", () => {
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})!;
    const child = fakeChild();
    const { jobId } = startLocalVideoJob(
      { config, prompt: "p", outputPath: path.join(dir, "clip.mp4") },
      vi.fn(() => child) as never,
    );
    child.stderr.emit("data", Buffer.from("loading\nValueError: out of memory\n"));
    child.emit("exit", 1);
    const job = getLocalVideoJob(jobId)!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("out of memory");
  });

  it("stops a render that runs past its time limit", () => {
    vi.useFakeTimers();
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir, maxMinutes: 1 }, {})!;
    const child = fakeChild();
    const { jobId } = startLocalVideoJob(
      { config, prompt: "p", outputPath: path.join(dir, "clip.mp4") },
      vi.fn(() => child) as never,
    );
    vi.advanceTimersByTime(60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(getLocalVideoJob(jobId)?.status).toBe("failed");
  });

  it("waits for a running job to finish, up to the limit", async () => {
    vi.useFakeTimers();
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})!;
    const child = fakeChild();
    const outputPath = path.join(dir, "wait.mp4");
    const { jobId } = startLocalVideoJob(
      { config, prompt: "p", outputPath },
      vi.fn(() => child) as never,
    );

    const timedOut = waitForLocalVideoJob(jobId, 10_000, 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await timedOut)?.status).toBe("running");

    const finished = waitForLocalVideoJob(jobId, 60_000, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    fs.writeFileSync(outputPath, "mp4");
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await finished)?.status).toBe("succeeded");
  });

  it("cancels a running job", () => {
    const config = resolveLocalVideoConfig({ pythonPath: python, modelDir }, {})!;
    const child = fakeChild();
    const { jobId } = startLocalVideoJob(
      { config, prompt: "p", outputPath: path.join(dir, "clip.mp4") },
      vi.fn(() => child) as never,
    );
    expect(cancelLocalVideoJob(jobId)).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    child.emit("exit", null);
    expect(getLocalVideoJob(jobId)?.status).toBe("cancelled");
    expect(cancelLocalVideoJob(jobId)).toBe(false);
  });
});
