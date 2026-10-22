import { useEffect, useRef, useState } from "react";
import { Copy, FolderOpen, Image as ImageIcon, Search, X } from "lucide-react";
import type { MeshyGallery, MeshyGalleryItem, MeshyLocalModel } from "../../../shared/meshy";
import { MeshyFormatMenu, MeshyNextMenu } from "./MeshyMenus";
import { closeModelGallery, type ModelGalleryRequest } from "./model-gallery-store";
import { ModelViewer } from "./ModelViewer";

type Selection =
  | { kind: "file"; path: string; workspacePath?: string; taskId?: string; label: string }
  | { kind: "remote"; item: MeshyGalleryItem };

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
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

function Thumb({ url }: { url: string | null }) {
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
    <span className="model-gallery-thumb" />
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

  return (
    <dialog
      ref={dialogRef}
      className="model-gallery"
      aria-label="3D models"
      onClose={closeModelGallery}
      onCancel={closeModelGallery}
    >
      <div className="model-gallery-header">
        <span className="model-gallery-title">3D models</span>
        {status?.configured && typeof status.balance === "number" && (
          <span className="model-gallery-balance">
            {status.balance.toLocaleString()} Meshy credits
          </span>
        )}
        {status?.error && (
          <span className="model-gallery-balance model-card-error">{status.error}</span>
        )}
        <span className="model-card-spacer" />
        <button
          type="button"
          className="model-viewer-btn"
          aria-label="Close"
          onClick={closeModelGallery}
        >
          <X size={16} />
        </button>
      </div>
      <div className="model-gallery-body">
        <aside className="model-gallery-list">
          <label className="model-gallery-search">
            <Search size={13} />
            <input
              type="search"
              placeholder="Search by prompt"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {loadError && <div className="model-card-line model-card-error">{loadError}</div>}
          {!gallery && !loadError && <div className="model-card-line">Loading…</div>}
          {status && !status.installed && (
            <div className="model-card-line">
              Add the Meshy connector in Settings → Connectors to generate models.
            </div>
          )}
          {status?.installed && !status.configured && (
            <div className="model-card-line">
              Add your Meshy API key in Settings → Connectors → Meshy.
            </div>
          )}
          {recent.length > 0 && <div className="model-gallery-section">Recent from Meshy</div>}
          {recent.map((item) => (
            <button
              key={item.taskId}
              type="button"
              className={`model-gallery-row${selectedTask === item.taskId ? " is-selected" : ""}`}
              onClick={() => void selectRemote(item)}
            >
              <Thumb url={item.thumbnailUrl} />
              <span className="model-gallery-row-text">
                <span className="model-gallery-row-title">{item.prompt || item.taskType}</span>
                <span className="model-gallery-row-sub">
                  {item.kind === "image" ? <ImageIcon size={11} /> : null}
                  {item.taskType}
                  {typeof item.credits === "number" ? ` · ${item.credits} cr` : ""}
                  {item.localPath ? " · saved" : ""}
                </span>
              </span>
            </button>
          ))}
          {local.length > 0 && <div className="model-gallery-section">On this machine</div>}
          {local.map((model) => (
            <button
              key={model.path}
              type="button"
              className={`model-gallery-row${selection?.kind === "file" && selection.path === model.path ? " is-selected" : ""}`}
              onClick={() => selectLocal(model)}
              title={model.path}
            >
              <span className="model-gallery-thumb" />
              <span className="model-gallery-row-text">
                <span className="model-gallery-row-title">{model.prompt || model.name}</span>
                <span className="model-gallery-row-sub">
                  {model.name} · {formatBytes(model.bytes)}
                </span>
              </span>
            </button>
          ))}
          {gallery && recent.length === 0 && local.length === 0 && status?.configured && (
            <div className="model-card-line">No models yet. Ask CoWork to make one.</div>
          )}
        </aside>
        <section className="model-gallery-detail">
          {!selection && <div className="model-gallery-empty">Pick a model to view it.</div>}
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
              {resolving && "Downloading the model…"}
              {image && <img alt={selectedLabel} src={image} className="model-gallery-image" />}
              {selectionError && <span className="model-card-error">{selectionError}</span>}
            </div>
          )}
          {selection && (
            <div className="model-gallery-made-from">
              <div className="model-gallery-prompt">{selectedLabel}</div>
              <div className="model-gallery-actions">
                {selectedLabel && (
                  <button
                    type="button"
                    className="model-card-btn"
                    onClick={() => copyText(selectedLabel)}
                  >
                    <Copy size={13} />
                    <span>Copy prompt</span>
                  </button>
                )}
                {selectedTask && (
                  <button
                    type="button"
                    className="model-card-btn"
                    onClick={() => copyText(selectedTask)}
                  >
                    <Copy size={13} />
                    <span>Copy task ID</span>
                  </button>
                )}
                {selection.kind === "file" && !selection.workspacePath && (
                  <button
                    type="button"
                    className="model-card-btn"
                    onClick={() =>
                      void window.electronAPI.revealMeshyModel?.({ filePath: selection.path })
                    }
                  >
                    <FolderOpen size={13} />
                    <span>Show in Finder</span>
                  </button>
                )}
                {selectedTask && <MeshyNextMenu taskId={selectedTask} />}
                {selectedTask && selection.kind === "file" && (
                  <MeshyFormatMenu
                    taskId={selectedTask}
                    beside={selection.workspacePath ? undefined : selection.path}
                  />
                )}
              </div>
            </div>
          )}
        </section>
      </div>
      {gallery && <div className="model-gallery-footer">Meshy saves to {gallery.dataDir}</div>}
    </dialog>
  );
}
