import { useEffect, useRef, useState } from "react";
import {
  Box,
  Coins,
  Copy,
  FolderOpen,
  Hash,
  Image as ImageIcon,
  KeyRound,
  Search,
  X,
} from "lucide-react";
import type { MeshyGallery, MeshyGalleryItem, MeshyLocalModel } from "../../../shared/meshy";
import { MeshyFormatMenu, MeshyNextMenu } from "./MeshyMenus";
import { closeModelGallery, type ModelGalleryRequest } from "./model-gallery-store";
import { ModelViewer } from "./ModelViewer";

type Selection =
  | { kind: "file"; path: string; workspacePath?: string; taskId?: string; label: string }
  | { kind: "remote"; item: MeshyGalleryItem };

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function selectionFromRequest(request: ModelGalleryRequest): Selection | null {
  if (!request.path) return null;
  return {
    kind: "file",
    path: request.path,
    workspacePath: request.workspacePath,
    taskId: request.taskId,
    label: request.title || request.path.split(/[\\/]/).pop() || request.path,
  };
}

function Thumb({ url, kind }: { url: string | null; kind: "model" | "image" }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (url && window.electronAPI.getMeshyImage) {
      window.electronAPI
        .getMeshyImage({ url })
        .then((result) => live && setSrc(result.dataUrl))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [url]);
  return src ? (
    <img alt="" src={src} className="model-gallery-thumb" />
  ) : (
    <span className="model-gallery-thumb is-placeholder" aria-hidden="true">
      {kind === "image" ? <ImageIcon size={16} /> : <Box size={16} />}
    </span>
  );
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** The 3D gallery: recent Meshy generations and models on this machine beside a viewer. */
export function ModelGallery({ request }: { request: ModelGalleryRequest }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [gallery, setGallery] = useState<MeshyGallery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | null>(() => selectionFromRequest(request));
  const [resolving, setResolving] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    setSelection(selectionFromRequest(request));
  }, [request]);

  useEffect(() => {
    let live = true;
    window.electronAPI
      .getMeshyGallery?.({ limit: 30 })
      .then((next) => live && setGallery(next))
      .catch((error: unknown) => live && setLoadError(errorText(error)));
    return () => {
      live = false;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (text: string | null | undefined) =>
    !needle || (text ?? "").toLowerCase().includes(needle);
  const recent = (gallery?.recent ?? []).filter(
    (item) => matches(item.prompt) || matches(item.taskId),
  );
  const local = (gallery?.local ?? []).filter(
    (model) => matches(model.prompt) || matches(model.name),
  );

  const selectLocal = (model: MeshyLocalModel) => {
    setSelectionError(null);
    setImage(null);
    setSelection({
      kind: "file",
      path: model.path,
      taskId: model.taskId ?? undefined,
      label: model.prompt || model.name,
    });
  };

  const selectRemote = async (item: MeshyGalleryItem) => {
    setSelectionError(null);
    setImage(null);
    if (item.kind === "model" && item.localPath) {
      setSelection({ kind: "file", path: item.localPath, taskId: item.taskId, label: item.prompt });
      return;
    }
    setSelection({ kind: "remote", item });
    if (item.kind === "image") {
      if (item.thumbnailUrl && window.electronAPI.getMeshyImage) {
        window.electronAPI
          .getMeshyImage({ url: item.thumbnailUrl })
          .then((result) => setImage(result.dataUrl))
          .catch((error: unknown) => setSelectionError(errorText(error)));
      }
      return;
    }
    if (!window.electronAPI.saveMeshyFormat) return;
    setResolving(true);
    try {
      // Viewing a generation keeps a free local copy, so it stays after Meshy's links expire.
      const saved = await window.electronAPI.saveMeshyFormat({
        taskId: item.taskId,
        format: "glb",
      });
      setSelection({ kind: "file", path: saved.path, taskId: item.taskId, label: item.prompt });
    } catch (error) {
      setSelectionError(errorText(error));
    } finally {
      setResolving(false);
    }
  };

  const status = gallery?.status;
  const selectedTask =
    selection?.kind === "file"
      ? selection.taskId
      : selection?.kind === "remote"
        ? selection.item.taskId
        : undefined;
  const selectedLabel =
    selection?.kind === "file"
      ? selection.label
      : selection?.kind === "remote"
        ? selection.item.prompt
        : "";

  const recentCount = recent.length;
  const localCount = local.length;

  return (
    <dialog
      ref={dialogRef}
      className="model-gallery"
      aria-label="3D models"
      onClose={closeModelGallery}
      onCancel={closeModelGallery}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (event.target === dialogRef.current) closeModelGallery();
      }}
    >
      <aside className="model-gallery-side">
        <div className="model-gallery-brand">
          <span className="model-gallery-title">3D models</span>
          {status?.configured && typeof status.balance === "number" && (
            <span className="model-gallery-credits" title="Meshy credits left">
              <Coins size={12} />
              {status.balance.toLocaleString()}
            </span>
          )}
        </div>
        <label className="model-gallery-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Search by prompt"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="model-gallery-list">
          {loadError && <p className="model-gallery-note is-error">{loadError}</p>}
          {!gallery && !loadError && (
            <p className="model-gallery-note">
              <span className="model-spinner" /> Loading
            </p>
          )}
          {status && !status.installed && (
            <p className="model-gallery-note">
              Add the Meshy connector in Settings → Connectors to generate models.
            </p>
          )}
          {status?.installed && !status.configured && (
            <p className="model-gallery-note">
              <KeyRound size={13} /> Add your Meshy API key in Settings → Connectors → Meshy.
            </p>
          )}
          {status?.error && <p className="model-gallery-note is-error">{status.error}</p>}
          {recentCount > 0 && (
            <div className="model-gallery-section">
              Recent from Meshy <span>{recentCount}</span>
            </div>
          )}
          {recent.map((item) => (
            <button
              key={item.taskId}
              type="button"
              className={`model-gallery-row${selectedTask === item.taskId ? " is-selected" : ""}`}
              onClick={() => void selectRemote(item)}
            >
              <Thumb url={item.thumbnailUrl} kind={item.kind} />
              <span className="model-gallery-row-text">
                <span className="model-gallery-row-title">{item.prompt || item.taskType}</span>
                <span className="model-gallery-row-sub">
                  {item.taskType.replace(/-/g, " ")}
                  {typeof item.credits === "number" ? ` · ${item.credits} cr` : ""}
                  {item.localPath ? " · saved" : ""}
                </span>
              </span>
            </button>
          ))}
          {localCount > 0 && (
            <div className="model-gallery-section">
              On this machine <span>{localCount}</span>
            </div>
          )}
          {local.map((model) => (
            <button
              key={model.path}
              type="button"
              className={`model-gallery-row${selection?.kind === "file" && selection.path === model.path ? " is-selected" : ""}`}
              onClick={() => selectLocal(model)}
              title={model.path}
            >
              <Thumb url={null} kind="model" />
              <span className="model-gallery-row-text">
                <span className="model-gallery-row-title">{model.prompt || model.name}</span>
                <span className="model-gallery-row-sub">
                  {model.prompt ? `${model.name} · ` : ""}
                  {formatBytes(model.bytes)}
                </span>
              </span>
            </button>
          ))}
          {gallery && recentCount === 0 && localCount === 0 && status?.configured && (
            <p className="model-gallery-note">No models yet. Ask CoWork to make one.</p>
          )}
        </div>
        {gallery && (
          <div className="model-gallery-folder" title={gallery.dataDir}>
            <FolderOpen size={12} />
            <span>{gallery.dataDir}</span>
          </div>
        )}
      </aside>
      <section className="model-gallery-stage">
        {!selection && (
          <div className="model-gallery-empty">
            <span className="model-card-badge">
              <Box size={18} />
            </span>
            <span>Pick a model to view it</span>
          </div>
        )}
        {selection?.kind === "file" && (
          <ModelViewer
            key={selection.path}
            className="model-gallery-viewer"
            autoRotate
            source={{ path: selection.path, workspacePath: selection.workspacePath }}
          />
        )}
        {selection?.kind === "remote" && (
          <div className="model-gallery-empty">
            {resolving && (
              <>
                <span className="model-spinner" />
                <span>Downloading the model</span>
              </>
            )}
            {image && <img alt={selectedLabel} src={image} className="model-gallery-image" />}
            {selectionError && <span className="model-card-error">{selectionError}</span>}
          </div>
        )}
        <div className="model-gallery-top">
          {selection ? (
            <span className="model-card-heading">
              <span className="model-card-title" title={selectedLabel}>
                {selectedLabel}
              </span>
              {selectedTask && (
                <span className="model-card-subtitle">Meshy task {selectedTask.slice(0, 8)}</span>
              )}
            </span>
          ) : (
            <span />
          )}
          <span className="model-card-actions is-visible">
            {selection && selectedLabel && (
              <button
                type="button"
                className="model-glass-btn is-icon"
                title="Copy prompt"
                aria-label="Copy prompt"
                onClick={() => copyText(selectedLabel)}
              >
                <Copy size={14} />
              </button>
            )}
            {selectedTask && (
              <button
                type="button"
                className="model-glass-btn is-icon"
                title="Copy task ID"
                aria-label="Copy task ID"
                onClick={() => copyText(selectedTask)}
              >
                <Hash size={14} />
              </button>
            )}
            {selection?.kind === "file" && !selection.workspacePath && (
              <button
                type="button"
                className="model-glass-btn is-icon"
                title="Show in Finder"
                aria-label="Show in Finder"
                onClick={() =>
                  void window.electronAPI.revealMeshyModel?.({ filePath: selection.path })
                }
              >
                <FolderOpen size={14} />
              </button>
            )}
            {selectedTask && selection?.kind === "file" && (
              <MeshyFormatMenu
                taskId={selectedTask}
                beside={selection.path}
                workspacePath={selection.workspacePath}
                iconOnly
              />
            )}
            {selectedTask && <MeshyNextMenu taskId={selectedTask} />}
            <span className="model-gallery-divider" aria-hidden="true" />
            <button
              type="button"
              className="model-glass-btn is-icon"
              title="Close"
              aria-label="Close"
              onClick={closeModelGallery}
            >
              <X size={15} />
            </button>
          </span>
        </div>
      </section>
    </dialog>
  );
}
