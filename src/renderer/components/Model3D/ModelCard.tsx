import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Box, KeyRound, Maximize2, Play } from "lucide-react";
import type { MeshyTaskInfo } from "../../../shared/meshy";
import { useLiveFrameSlot } from "../../hooks/useLiveFrameSlot";
import { MeshyFormatMenu, MeshyNextMenu } from "./MeshyMenus";
import { MODEL_VIEWER_SLOTS, openModelGallery } from "./model-gallery-store";
import { describeStats, ModelViewer } from "./ModelViewer";
import type { ModelStats } from "./model-stage";
import "./model3d.css";

const RUNNING = new Set(["PENDING", "IN_PROGRESS"]);
const POLL_MS = 3000;

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

/** A live 3D view while the card holds a slot; a "View in 3D" poster while it is parked. */
function SlottedViewer({
  path,
  workspacePath,
  poster,
  onStats,
}: {
  path: string;
  workspacePath?: string;
  poster?: string | null;
  onStats: (stats: ModelStats) => void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { live, activate } = useLiveFrameSlot(element, MODEL_VIEWER_SLOTS);
  return (
    <div className="model-card-body" ref={setElement} onPointerDown={activate}>
      {live ? (
        <ModelViewer source={{ path, workspacePath }} showStats={false} onStats={onStats} />
      ) : (
        <Poster image={poster} label="View in 3D" onClick={activate} />
      )}
    </div>
  );
}

function Poster({
  image,
  label,
  disabled,
  onClick,
}: {
  image?: string | null;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="model-card-poster" disabled={disabled} onClick={onClick}>
      {image && <img alt="" src={image} className="model-card-poster-image" />}
      <span className="model-card-poster-cta">
        <span className="model-card-poster-play">
          <Play size={16} fill="currentColor" />
        </span>
        <span>{label}</span>
      </span>
    </button>
  );
}

const RING_RADIUS = 22;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function TaskProgress({ info, thumbnail }: { info: MeshyTaskInfo; thumbnail: string | null }) {
  const queued = info.status === "PENDING" && info.progress === 0;
  return (
    <div className="model-card-body model-card-progress">
      {thumbnail && <img alt="" src={thumbnail} className="model-card-progress-backdrop" />}
      <div className="model-card-progress-center" role="status">
        <svg className="model-card-ring" viewBox="0 0 52 52" aria-hidden="true">
          <circle className="model-card-ring-track" cx="26" cy="26" r={RING_RADIUS} />
          <circle
            className="model-card-ring-fill"
            cx="26"
            cy="26"
            r={RING_RADIUS}
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - (queued ? 0.04 : info.progress / 100))}
          />
        </svg>
        <span className="model-card-progress-value">{queued ? "…" : `${info.progress}%`}</span>
        <span className="model-card-progress-stage">
          {queued ? "Queued at Meshy" : `Meshy is ${info.stage}`}
        </span>
      </div>
      <div className="model-card-progress-bar" aria-hidden="true">
        <div style={{ width: `${info.progress}%` }} />
      </div>
    </div>
  );
}

function CompactCard({
  name,
  message,
  tone = "info",
}: {
  name: string;
  message: string;
  tone?: "info" | "error" | "busy" | "setup";
}) {
  return (
    <div className="model-card is-compact" data-tone={tone}>
      <span className="model-card-badge" aria-hidden="true">
        {tone === "busy" ? (
          <span className="model-spinner" />
        ) : tone === "error" ? (
          <AlertCircle size={16} />
        ) : tone === "setup" ? (
          <KeyRound size={16} />
        ) : (
          <Box size={16} />
        )}
      </span>
      <span className="model-card-compact-text">
        <span className="model-card-title">{name}</span>
        <span className="model-card-subtitle">{message}</span>
      </span>
    </div>
  );
}

function useMeshyImage(url: string | null | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDataUrl(null);
    if (url && window.electronAPI.getMeshyImage) {
      window.electronAPI
        .getMeshyImage({ url })
        .then((result) => live && setDataUrl(result.dataUrl))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [url]);
  return dataUrl;
}

function useMeshyTask(taskId: string | undefined): {
  info: MeshyTaskInfo | null;
  error: string | null;
} {
  const [info, setInfo] = useState<MeshyTaskInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const get = window.electronAPI.getMeshyTask;
    if (!taskId || !get) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      get({ taskId })
        .then((next) => {
          if (!live) return;
          setInfo(next);
          setError(null);
          if (RUNNING.has(next.status)) timer = setTimeout(tick, POLL_MS);
        })
        .catch((err: unknown) => {
          if (!live) return;
          setError(errorText(err));
          // A task created a moment ago can be missing briefly; try again, slower.
          timer = setTimeout(tick, POLL_MS * 4);
        });
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [taskId]);
  return { info, error };
}

/**
 * `::model{path="…" task="…" title="…"}` in a reply. With a path it shows that model;
 * with only a Meshy task id it shows the task's progress, then its model, downloading the
 * GLB (free) into Meshy's folder when the card first needs it.
 */
export function ModelCard({
  path,
  taskId,
  title,
  workspacePath,
  chatTaskId,
  streaming = false,
}: {
  path?: string;
  taskId?: string;
  title?: string;
  workspacePath?: string;
  chatTaskId?: string;
  streaming?: boolean;
}) {
  const { info, error } = useMeshyTask(path ? undefined : taskId);
  const thumbnail = useMeshyImage(path ? null : info?.thumbnailUrl);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const modelPath = path ?? savedPath;
  // Files Meshy saved are known by their absolute path; a workspace path is joined first.
  const absoluteModelPath =
    modelPath && (modelPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(modelPath))
      ? modelPath
      : modelPath && workspacePath
        ? `${workspacePath.replace(/[\\/]+$/, "")}/${modelPath.replace(/^\.?[\\/]/, "")}`
        : undefined;
  const done = info?.status === "SUCCEEDED";
  const name =
    title || info?.prompt || (path ? fileName(path) : `Meshy task ${taskId?.slice(0, 8)}`);

  const fetchModel = useCallback(async (): Promise<string | null> => {
    if (modelPath) return modelPath;
    if (!taskId || !window.electronAPI.saveMeshyFormat) return null;
    setOpening(true);
    setOpenError(null);
    try {
      const saved = await window.electronAPI.saveMeshyFormat({
        taskId,
        format: "glb",
        chatTaskId,
      });
      setSavedPath(saved.path);
      return saved.path;
    } catch (err) {
      setOpenError(`Could not download the model: ${errorText(err)}`);
      return null;
    } finally {
      setOpening(false);
    }
  }, [chatTaskId, modelPath, taskId]);

  if (!modelPath) {
    if (!taskId) {
      return (
        <CompactCard
          name={name}
          message="This 3D card needs a path or a Meshy task."
          tone="error"
        />
      );
    }
    if (!info) {
      return error ? (
        <CompactCard
          name={name}
          message={error}
          tone={/API key/i.test(error) ? "setup" : "error"}
        />
      ) : (
        <CompactCard name={name} message="Checking the Meshy task…" tone="busy" />
      );
    }
    if (info.error) {
      return (
        <CompactCard
          name={name}
          message={`Meshy task ${info.status.toLowerCase()}: ${info.error}`}
          tone="error"
        />
      );
    }
    if (done && !info.hasModel && !thumbnail) {
      return <CompactCard name={name} message="Done. This task has no 3D file." />;
    }
  }

  let body;
  if (modelPath) {
    body = (
      <SlottedViewer
        path={modelPath}
        workspacePath={workspacePath}
        poster={thumbnail}
        onStats={(stats) => setSubtitle(describeStats(stats))}
      />
    );
  } else if (info && !done) {
    body = <TaskProgress info={info} thumbnail={thumbnail} />;
  } else if (info?.hasModel) {
    body = (
      <div className="model-card-body">
        <Poster
          image={thumbnail}
          disabled={opening || streaming}
          onClick={() => void fetchModel()}
          label={
            opening
              ? "Downloading the model…"
              : streaming
                ? "Waiting for the reply to finish…"
                : (openError ?? "View in 3D")
          }
        />
      </div>
    );
  } else {
    body = (
      <div className="model-card-body model-card-images">
        {thumbnail && <img alt={name} src={thumbnail} />}
      </div>
    );
  }

  const showTaskMenus = Boolean(taskId) && (Boolean(path) || done) && !streaming;
  const meta = [
    subtitle,
    done && typeof info?.credits === "number" ? `${info.credits} credits` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <figure
      className="model-card"
      data-model-card={info?.status ?? (path ? "file" : "loading")}
      aria-label={name}
    >
      {body}
      <figcaption className="model-card-top">
        <span className="model-card-heading">
          <span className="model-card-title" title={name}>
            {name}
          </span>
          {meta && <span className="model-card-subtitle">{meta}</span>}
        </span>
        <span className="model-card-actions">
          {showTaskMenus && taskId && <MeshyNextMenu taskId={taskId} />}
          {showTaskMenus && taskId && (path || info?.hasModel) && (
            <MeshyFormatMenu
              taskId={taskId}
              beside={absoluteModelPath}
              workspacePath={workspacePath}
              chatTaskId={chatTaskId}
              iconOnly
            />
          )}
          {(modelPath || info?.hasModel) && (
            <button
              type="button"
              className="model-glass-btn is-icon"
              title="Open in the 3D gallery"
              aria-label="Open in the 3D gallery"
              disabled={opening}
              onClick={() => {
                void fetchModel().then((resolved) =>
                  openModelGallery({
                    path: resolved ?? undefined,
                    workspacePath,
                    taskId,
                    title: name,
                  }),
                );
              }}
            >
              <Maximize2 size={14} />
            </button>
          )}
        </span>
      </figcaption>
    </figure>
  );
}
