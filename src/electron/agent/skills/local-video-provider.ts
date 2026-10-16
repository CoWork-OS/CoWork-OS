/**
 * Local video provider: runs an open video model on this machine (Wan 2.2 via
 * mlx-video on Apple Silicon) instead of a cloud API. Nothing leaves the Mac,
 * and there is no per-clip cost.
 *
 * The converted model folder must also hold the text tokenizer at
 * google/umt5-xxl (copied from the original Wan download), because renders
 * run offline.
 *
 * Configuration comes from settings.videoGeneration.local, or from the
 * COWORK_LOCAL_VIDEO_PYTHON / COWORK_LOCAL_VIDEO_MODEL_DIR environment
 * variables (COWORK_LOCAL_VIDEO_STEPS optionally sets the sampling steps). The provider is offered only when both paths exist.
 *
 * A render takes minutes, so generate() starts a background job and
 * get_video_generation_job polls it, like the cloud providers.
 */
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface LocalVideoSettings {
  /** Python interpreter of the environment that has mlx-video installed. */
  pythonPath?: string;
  /** Converted MLX model directory (output of mlx_video.models.wan_2.convert). */
  modelDir?: string;
  /** Sampling steps; the model default is used when unset. */
  steps?: number;
  /** Most minutes one render may take before it is stopped. */
  maxMinutes?: number;
}

export interface LocalVideoConfig {
  pythonPath: string;
  modelDir: string;
  steps?: number;
  maxMs: number;
}

const WAN_FPS = 24;
const MAX_FRAMES = 121;
const DEFAULT_MAX_MINUTES = 60;
const STDERR_TAIL_CHARS = 4000;
const MAX_PROMPT_CHARS = 2000;
const KILL_GRACE_MS = 5000;
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;
const PYTHON_BASENAME = /^python[\d.]*$/;

// Only what Python and the Hugging Face loader need. The app's own environment
// can hold provider keys and tokens, which a local model has no use for.
const CHILD_ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"]);

function buildLocalVideoEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: "1",
    // The model is already on disk; never fetch weights during a render.
    HF_HUB_OFFLINE: "1",
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      CHILD_ENV_KEYS.has(key) ||
      key.startsWith("LC_") ||
      key === "HF_HOME" ||
      key === "HF_HUB_CACHE"
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

export function resolveLocalVideoConfig(
  settings: LocalVideoSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LocalVideoConfig | null {
  const pythonPath = settings?.pythonPath?.trim() || env.COWORK_LOCAL_VIDEO_PYTHON?.trim() || "";
  const modelDir = settings?.modelDir?.trim() || env.COWORK_LOCAL_VIDEO_MODEL_DIR?.trim() || "";
  if (!pythonPath || !modelDir) return null;
  if (!path.isAbsolute(pythonPath) || !path.isAbsolute(modelDir)) return null;
  // The interpreter is run with fixed arguments, so it must at least be a
  // Python executable rather than any program a settings write points at.
  if (!PYTHON_BASENAME.test(path.basename(pythonPath))) return null;
  try {
    if (!fs.statSync(pythonPath).isFile()) return null;
    fs.accessSync(pythonPath, fs.constants.X_OK);
    if (!fs.statSync(modelDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const envSteps = Number(env.COWORK_LOCAL_VIDEO_STEPS);
  const rawSteps = settings?.steps ?? (Number.isFinite(envSteps) ? envSteps : undefined);
  // Fewer steps renders faster at some cost in detail; 1-100 like the settings schema.
  const steps =
    Number.isInteger(rawSteps) && (rawSteps as number) >= 1 && (rawSteps as number) <= 100
      ? (rawSteps as number)
      : undefined;
  const maxMinutes =
    Number.isFinite(settings?.maxMinutes) && (settings?.maxMinutes as number) > 0
      ? (settings?.maxMinutes as number)
      : DEFAULT_MAX_MINUTES;
  return { pythonPath, modelDir, steps, maxMs: Math.round(maxMinutes * 60_000) };
}

/** Frame size the 5B model renders well on a laptop; both sides divisible by 32. */
export function localVideoSize(aspectRatio?: string): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 480, height: 832 };
  if (aspectRatio === "1:1") return { width: 640, height: 640 };
  return { width: 832, height: 480 };
}

/** Wan wants 4n+1 frames; a 2 s clip at 24 fps is 49 frames. */
export function localVideoFrames(durationSeconds?: number): number {
  const seconds =
    Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
      ? (durationSeconds as number)
      : 2;
  const n = Math.max(1, Math.round((seconds * WAN_FPS) / 4));
  return Math.min(n * 4 + 1, MAX_FRAMES);
}

export function buildLocalVideoArgs(input: {
  config: LocalVideoConfig;
  prompt: string;
  outputPath: string;
  referenceImagePath?: string;
  aspectRatio?: string;
  duration?: number;
  seed?: number;
}): string[] {
  const { width, height } = localVideoSize(input.aspectRatio);
  // "--flag=value" keeps a value that starts with "--" from being read as a flag.
  const prompt = input.prompt.replace(/\0/g, "").slice(0, MAX_PROMPT_CHARS);
  const args = [
    "-m",
    "mlx_video.models.wan_2.generate",
    `--model-dir=${input.config.modelDir}`,
    `--prompt=${prompt}`,
    "--width",
    String(width),
    "--height",
    String(height),
    "--num-frames",
    String(localVideoFrames(input.duration)),
    `--output-path=${input.outputPath}`,
  ];
  if (input.referenceImagePath) args.push(`--image=${input.referenceImagePath}`);
  if (input.config.steps) args.push("--steps", String(input.config.steps));
  if (Number.isInteger(input.seed)) args.push("--seed", String(input.seed));
  return args;
}

interface LocalVideoJob {
  status: "running" | "succeeded" | "failed" | "cancelled";
  outputPath: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  stderrTail: string;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, LocalVideoJob>();

type Spawn = typeof spawn;

function pruneFinishedJobs(now = Date.now()): void {
  for (const [jobId, job] of jobs) {
    if (job.status !== "running" && job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

/** A render uses most of the GPU and memory; run one at a time. */
export function getRunningLocalVideoJobId(): string | null {
  for (const [jobId, job] of jobs) if (job.status === "running") return jobId;
  return null;
}

function stopChild(child: ChildProcess): void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      // The child leads its own process group, so workers it spawned stop too.
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      child.kill(sig);
    }
  };
  signal("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
  }, KILL_GRACE_MS);
  forceKill.unref?.();
}

function finish(job: LocalVideoJob, status: LocalVideoJob["status"], error?: string): void {
  job.status = status;
  job.finishedAt = Date.now();
  if (error) job.error = error;
  if (job.timer) clearTimeout(job.timer);
}

export function startLocalVideoJob(
  input: Parameters<typeof buildLocalVideoArgs>[0],
  spawnImpl: Spawn = spawn,
): { jobId: string } {
  pruneFinishedJobs();
  const running = getRunningLocalVideoJobId();
  if (running) {
    throw new Error(
      `The local video model is busy with job ${running}. Poll it with get_video_generation_job and start the next clip when it finishes.`,
    );
  }
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const jobId = `local-${randomUUID()}`;
  const job: LocalVideoJob = {
    status: "running",
    outputPath: input.outputPath,
    startedAt: Date.now(),
    stderrTail: "",
  };
  jobs.set(jobId, job);

  // No shell: the prompt is a single argv entry and cannot be interpreted.
  const child = spawnImpl(input.config.pythonPath, buildLocalVideoArgs(input), {
    // mlx-video loads its tokenizer as "google/umt5-xxl"; running from the
    // model folder resolves that to the copy stored next to the weights.
    cwd: input.config.modelDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: buildLocalVideoEnvironment(),
    detached: true,
  });
  job.child = child;
  child.stderr?.on("data", (chunk: Buffer) => {
    job.stderrTail = (job.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  job.timer = setTimeout(() => {
    if (job.status !== "running") return;
    finish(
      job,
      "failed",
      `Local video render stopped after ${Math.round(input.config.maxMs / 60_000)} minutes.`,
    );
    stopChild(child);
  }, input.config.maxMs);
  child.on("error", (error) => {
    if (job.status !== "running") return;
    finish(job, "failed", `Could not start the local video model: ${error.message}`);
  });
  child.on("exit", (code) => {
    job.child = undefined;
    if (job.status !== "running") return;
    if (code === 0 && fs.existsSync(job.outputPath)) {
      finish(job, "succeeded");
      return;
    }
    const tail = job.stderrTail.trim().split("\n").slice(-6).join("\n");
    finish(
      job,
      "failed",
      `Local video model exited with code ${code ?? "unknown"}${tail ? `: ${tail}` : ""}`,
    );
  });
  return { jobId };
}

export function getLocalVideoJob(jobId: string): {
  status: LocalVideoJob["status"];
  outputPath: string;
  elapsedSeconds: number;
  error?: string;
} | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    status: job.status,
    outputPath: job.outputPath,
    elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
    ...(job.error ? { error: job.error } : {}),
  };
}

/**
 * Wait until a running job finishes, or until maxWaitMs passes. A local render
 * takes minutes, so one poll that waits keeps the agent from many quick polls
 * (and from giving up while the clip is still being made).
 */
export async function waitForLocalVideoJob(
  jobId: string,
  maxWaitMs: number,
  intervalMs = 2000,
): Promise<ReturnType<typeof getLocalVideoJob>> {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let job = getLocalVideoJob(jobId);
  while (job?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())),
    );
    job = getLocalVideoJob(jobId);
  }
  return job;
}

export function cancelLocalVideoJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return false;
  finish(job, "cancelled");
  if (job.child) stopChild(job.child);
  return true;
}

/** Stop every running render, e.g. when the app quits. */
export function stopAllLocalVideoJobs(): void {
  for (const jobId of jobs.keys()) cancelLocalVideoJob(jobId);
}
