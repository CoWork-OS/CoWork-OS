import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { MeetingArtifactProvider, MeetingArtifactSummary } from "../../shared/types";

const ARTIFACT_ID_RE = /^[a-z0-9-]{1,40}:[A-Za-z0-9_-]{8,128}$/;

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "meeting"
  );
}

/** Stable, filesystem-safe id derived from the provider's transcript identity. */
export function artifactIdFor(provider: MeetingArtifactProvider, sourceKey: string): string {
  return `${provider}:${createHash("sha256").update(sourceKey).digest("base64url").slice(0, 32)}`;
}

/**
 * Local store for meeting artifacts: one Markdown transcript plus a JSON
 * sidecar per artifact under `<root>/<provider>/`. Writes are atomic, so a
 * crash never leaves a half-written artifact that a later sync would skip.
 */
export class MeetingArtifactStore {
  constructor(private readonly root: string) {}

  get rootDir(): string {
    return this.root;
  }

  exists(id: string): boolean {
    return fs.existsSync(this.metaPath(id));
  }

  write(
    summary: Omit<MeetingArtifactSummary, "markdownPath">,
    markdown: string,
  ): MeetingArtifactSummary {
    const dir = this.providerDir(summary.provider);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const date = (summary.startTime || summary.retrievedAt).slice(0, 10);
    const fileBase = `${date}-${slugify(summary.title)}-${this.fileKey(summary.id)}`;
    const markdownPath = path.join(dir, `${fileBase}.md`);
    const full: MeetingArtifactSummary = { ...summary, markdownPath };
    this.atomicWrite(markdownPath, markdown);
    this.atomicWrite(this.metaPath(summary.id), JSON.stringify(full, null, 2));
    return full;
  }

  update(id: string, patch: Partial<MeetingArtifactSummary>): MeetingArtifactSummary | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, provider: current.provider };
    this.atomicWrite(this.metaPath(id), JSON.stringify(next, null, 2));
    return next;
  }

  get(id: string): MeetingArtifactSummary | null {
    if (!ARTIFACT_ID_RE.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as MeetingArtifactSummary;
    } catch {
      return null;
    }
  }

  readMarkdown(id: string): string | null {
    const artifact = this.get(id);
    if (!artifact) return null;
    try {
      return fs.readFileSync(artifact.markdownPath, "utf8");
    } catch {
      return null;
    }
  }

  list(
    options: { provider?: MeetingArtifactProvider; limit?: number } = {},
  ): MeetingArtifactSummary[] {
    const providers: MeetingArtifactProvider[] = options.provider
      ? [options.provider]
      : ["teams", "google-meet"];
    const results: MeetingArtifactSummary[] = [];
    for (const provider of providers) {
      const dir = path.join(this.providerDir(provider), ".meta");
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          results.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
        } catch {
          // Skip unreadable sidecars rather than failing the whole listing.
        }
      }
    }
    results.sort((a, b) =>
      (b.startTime || b.retrievedAt).localeCompare(a.startTime || a.retrievedAt),
    );
    return results.slice(0, options.limit ?? results.length);
  }

  recordingPath(id: string, recordingId: string, extension = "mp4"): string {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`Unknown meeting artifact: ${id}`);
    const safeRecording = recordingId.replace(/[^A-Za-z0-9_-]/g, "").slice(-48) || "recording";
    return path.join(
      this.providerDir(artifact.provider),
      "recordings",
      `${this.fileKey(id)}-${safeRecording}.${extension}`,
    );
  }

  private providerDir(provider: MeetingArtifactProvider): string {
    return path.join(this.root, provider);
  }

  private fileKey(id: string): string {
    return id.split(":")[1].slice(-12);
  }

  private metaPath(id: string): string {
    const [provider, key] = id.split(":");
    return path.join(this.providerDir(provider as MeetingArtifactProvider), ".meta", `${key}.json`);
  }

  private atomicWrite(target: string, contents: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}
