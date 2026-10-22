import { useCallback, useEffect, useState } from "react";
import { Box, Maximize2, Play } from "lucide-react";
import type { MeshyTaskInfo } from "../../../shared/meshy";
import { useLiveFrameSlot } from "../../hooks/useLiveFrameSlot";
import { MeshyFormatMenu, MeshyNextMenu } from "./MeshyMenus";
import { MODEL_VIEWER_SLOTS, openModelGallery } from "./model-gallery-store";
import { ModelViewer } from "./ModelViewer";
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
}: {
  path: string;
  workspacePath?: string;
  poster?: string | null;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { live, activate } = useLiveFrameSlot(element, MODEL_VIEWER_SLOTS);
  return (
    <div className="model-card-body" ref={setElement} onPointerDown={activate}>
      {live ? (
        <ModelViewer source={{ path, workspacePath }} />
      ) : (
        <button
          type="button"
          className="model-card-poster"
          style={poster ? { backgroundImage: `url(${poster})` } : undefined}
          onClick={activate}
        >
          <Play size={22} />
          <span>View in 3D</span>
        </button>
      )}
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

  let body;
  if (modelPath) {
    body = <SlottedViewer path={modelPath} workspacePath={workspacePath} poster={thumbnail} />;
  } else if (!taskId) {
    body = (
      <div className="model-card-line model-card-error">
        This 3D card needs a path or a Meshy task.
      </div>
    );
  } else if (!info) {
    body = (
      <div className="model-card-line">
        {error ? `Meshy: ${error}` : "Checking the Meshy task…"}
      </div>
    );
  } else if (info.error) {
    body = (
      <div className="model-card-line model-card-error">
        Meshy task {info.status.toLowerCase()}: {info.error}
      </div>
    );
  } else if (!done) {
    body = (
      <div className="model-card-progress">
        {thumbnail && <img alt="" src={thumbnail} className="model-card-progress-thumb" />}
        <div className="model-card-progress-main">
          <div className="model-card-line">
            {info.status === "PENDING" && info.progress === 0
              ? "Meshy · queued"
              : `Meshy ${info.progress}% · ${info.stage}`}
          </div>
          <div className="model-card-bar">
            <div className="model-card-bar-fill" style={{ width: `${info.progress}%` }} />
          </div>
        </div>
      </div>
    );
  } else if (info.hasModel) {
    body = (
      <div className="model-card-body">
        <button
          type="button"
          className="model-card-poster"
          style={thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined}
          disabled={opening || streaming}
          onClick={() => void fetchModel()}
        >
          <Play size={22} />
          <span>
            {opening
              ? "Downloading the model…"
              : streaming
                ? "Waiting for the reply to finish…"
                : (openError ?? "View in 3D")}
          </span>
        </button>
      </div>
    );
  } else if (info.imageUrls.length || thumbnail) {
    body = (
      <div className="model-card-images">{thumbnail && <img alt={name} src={thumbnail} />}</div>
    );
  } else {
    body = <div className="model-card-line">Done. This task has no 3D file.</div>;
  }

  const showTaskMenus = Boolean(taskId) && (Boolean(path) || done) && !streaming;

  return (
    <div className="model-card" data-model-card={info?.status ?? (path ? "file" : "loading")}>
      <div className="model-card-header">
        <Box size={15} className="model-card-icon" />
        <span className="model-card-title" title={name}>
          {name}
        </span>
        {done && typeof info?.credits === "number" && (
          <span className="model-card-meta">{info.credits} cr</span>
        )}
        <span className="model-card-spacer" />
        {showTaskMenus && taskId && <MeshyNextMenu taskId={taskId} />}
        {showTaskMenus && taskId && (path || info?.hasModel) && (
          <MeshyFormatMenu
            taskId={taskId}
            beside={absoluteModelPath}
            workspacePath={workspacePath}
            chatTaskId={chatTaskId}
          />
        )}
        {(modelPath || info?.hasModel) && (
          <button
            type="button"
            className="model-card-btn"
            title="Open in the 3D gallery"
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
            <Maximize2 size={13} />
            <span>Open</span>
          </button>
        )}
      </div>
      {body}
    </div>
  );
}
