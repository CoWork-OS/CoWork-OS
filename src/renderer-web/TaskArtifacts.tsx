import { useEffect, useState } from "react";
import { BrowserHostTransport, webEndpoint } from "./transport";

type ArtifactEntry = {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
};

type ArtifactPage = {
  artifacts: ArtifactEntry[];
  nextOffset: number;
  hasMore: boolean;
};

const MAX_BROWSER_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export function TaskArtifacts({
  taskId,
  workspaceId,
  transport,
  connected,
  csrfToken,
}: {
  taskId: string;
  workspaceId: string;
  transport: BrowserHostTransport | null;
  connected: boolean;
  csrfToken: string;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!transport || !connected) return;
    let active = true;
    setLoading(true);
    setError("");
    void transport
      .request<unknown>("task.artifacts.list", { taskId, workspaceId })
      .then((value) => {
        const page = parseArtifactPage(value, taskId, workspaceId);
        if (!active) return;
        setArtifacts(page.artifacts);
        setNextOffset(page.nextOffset);
        setHasMore(page.hasMore);
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause, "Could not load task artifacts."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taskId, workspaceId, transport, connected]);

  const loadMore = async () => {
    if (!transport || !connected || !hasMore || loading) return;
    setLoading(true);
    setError("");
    try {
      const value = await transport.request<unknown>("task.artifacts.list", {
        taskId,
        workspaceId,
        offset: nextOffset,
      });
      const page = parseArtifactPage(value, taskId, workspaceId);
      setArtifacts((current) => {
        const seen = new Set(current.map((entry) => entry.artifactId));
        return [...current, ...page.artifacts.filter((entry) => !seen.has(entry.artifactId))];
      });
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(messageOf(cause, "Could not load more artifacts."));
    } finally {
      setLoading(false);
    }
  };

  const download = async (entry: ArtifactEntry) => {
    if (!transport || !connected || downloading) return;
    setDownloading(entry.artifactId);
    setError("");
    try {
      const value = await transport.request<unknown>(
        "artifact.download.create",
        { artifactId: entry.artifactId },
        { mutation: true, operationKey: crypto.randomUUID() },
      );
      const handle = parseDownloadHandle(value, entry.artifactId);
      if (handle.size > MAX_BROWSER_DOWNLOAD_BYTES) {
        throw new Error("This artifact exceeds the current browser download limit of 64 MiB.");
      }
      const response = await fetch(webEndpoint("artifacts/download"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CoWork-CSRF": csrfToken,
        },
        body: JSON.stringify({ handle: handle.handle }),
      });
      if (!response.ok) throw new Error("The artifact is no longer available for download.");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_DOWNLOAD_BYTES) {
        throw new Error("This artifact exceeds the current browser download limit of 64 MiB.");
      }
      const blob = await response.blob();
      if (blob.size !== handle.size) throw new Error("The artifact download was incomplete.");
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = handle.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (cause) {
      setError(messageOf(cause, "Could not download this artifact."));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <section className="web-task-artifacts" aria-label="Task artifacts">
      <h3>Task artifacts</h3>
      {error && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
      {loading && artifacts.length === 0 && <p className="web-muted">Loading artifacts…</p>}
      {!loading && artifacts.length === 0 && !error && (
        <p className="web-muted">No downloadable artifacts for this task.</p>
      )}
      {artifacts.length > 0 && (
        <ul className="web-artifact-list">
          {artifacts.map((entry) => (
            <li key={entry.artifactId}>
              <span className="web-artifact-name">{entry.name}</span>
              <span className="web-muted">{formatSize(entry.size)}</span>
              <button
                type="button"
                disabled={
                  !connected || downloading !== null || entry.size > MAX_BROWSER_DOWNLOAD_BYTES
                }
                title={
                  entry.size > MAX_BROWSER_DOWNLOAD_BYTES
                    ? "Above the current 64 MiB browser download limit"
                    : undefined
                }
                onClick={() => void download(entry)}
              >
                {downloading === entry.artifactId ? "Downloading…" : "Download"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button type="button" disabled={!connected || loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : "Load more artifacts"}
        </button>
      )}
    </section>
  );
}

function parseArtifactPage(value: unknown, taskId: string, workspaceId: string): ArtifactPage {
  if (
    !isRecord(value) ||
    value.taskId !== taskId ||
    value.workspaceId !== workspaceId ||
    !Array.isArray(value.artifacts) ||
    !Number.isSafeInteger(value.nextOffset) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("The host returned an invalid artifact page.");
  }
  const entries = value.artifacts.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.artifactId !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string" ||
      !Number.isSafeInteger(item.size) ||
      !Number.isFinite(item.createdAt)
    ) {
      throw new Error("The host returned invalid artifact metadata.");
    }
    return item as ArtifactEntry;
  });
  return { artifacts: entries, nextOffset: value.nextOffset as number, hasMore: value.hasMore };
}

function parseDownloadHandle(
  value: unknown,
  artifactId: string,
): {
  handle: string;
  fileName: string;
  size: number;
} {
  if (
    !isRecord(value) ||
    value.artifactId !== artifactId ||
    typeof value.handle !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.handle) ||
    typeof value.fileName !== "string" ||
    !Number.isSafeInteger(value.size)
  ) {
    throw new Error("The host returned an invalid artifact handle.");
  }
  return {
    handle: value.handle,
    fileName: value.fileName,
    size: value.size as number,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
