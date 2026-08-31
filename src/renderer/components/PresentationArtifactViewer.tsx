import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderOpen,
  Maximize2,
  Mic,
  Minimize2,
  Plus,
  Square,
  X,
} from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";
import type {
  ImageAttachment,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../shared/types";
import { getPresentationFormatLabel } from "../../shared/presentation-formats";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { ModelDropdown } from "./MainContent";
import type { SpreadsheetTurnContext } from "./SpreadsheetArtifactViewer";
import { PresentationArtifactCard } from "./PresentationArtifactCard";
import { PresentationViewer, type PresentationPreview } from "./PresentationViewer";
import "./artifact-viewers.css";

type PresentationArtifactViewerMode = "sidebar" | "fullscreen";
type PresentationSettingsTab = Any;
type PendingPresentationAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType?: string;
};

type PresentationArtifactViewerProps = {
  filePath: string;
  workspacePath: string;
  mode: PresentationArtifactViewerMode;
  onClose: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  onSendMessage?: (message: string, images?: ImageAttachment[]) => Promise<void>;
  selectedModelLabel?: string;
  selectedModel?: string;
  selectedProvider?: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  availableModels?: LLMModelInfo[];
  availableProviders?: LLMProviderInfo[];
  workspaceId?: string;
  onModelChange?: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  onOpenSettings?: (tab?: PresentationSettingsTab) => void;
  turnContext?: SpreadsheetTurnContext | null;
  refreshKey?: string | number | null;
};

type ViewerData = NonNullable<FileViewerResult["data"]>;

const presentationViewerDataCache = new Map<string, ViewerData>();

function getPresentationViewerCacheKey(args: {
  filePath: string;
  workspacePath: string;
  refreshKey?: string | number | null;
}): string {
  return `${args.workspacePath}::${args.filePath}::${args.refreshKey ?? ""}`;
}

function presentationPreviewNeedsRender(preview: PresentationPreview | null | undefined): boolean {
  return preview?.renderStatus === "rendering";
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function isImageAttachment(attachment: PendingPresentationAttachment): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.mimeType || "");
}

function buildPresentationText(preview: PresentationPreview | null): string {
  if (!preview) return "";
  return preview.slides
    .map((slide) => {
      const lines = [`Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""}`];
      if (slide.text) lines.push(slide.text);
      if (slide.notes) lines.push("Speaker notes:", slide.notes);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function PresentationArtifactViewer({
  filePath,
  workspacePath,
  mode,
  onClose,
  onFullscreen,
  onExitFullscreen,
  onSendMessage,
  selectedModelLabel,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels = [],
  availableProviders = [],
  workspaceId,
  onModelChange,
  onOpenSettings,
  turnContext,
  refreshKey,
}: PresentationArtifactViewerProps) {
  const [loading, setLoading] = useState(true);
  const [renderingImages, setRenderingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ViewerData | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const [fullscreenSending, setFullscreenSending] = useState(false);
  const [fullscreenAttachments, setFullscreenAttachments] = useState<
    PendingPresentationAttachment[]
  >([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [turnContextExpanded, setTurnContextExpanded] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const fileName = fileData?.fileName || getFileName(filePath);
  const formatLabel = getPresentationFormatLabel(fileName);
  const fullscreenLabel =
    mode === "fullscreen" ? "Exit full screen" : "Open presentation in full screen";
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceNotice("");
      setFullscreenMessage((current) => (current ? `${current} ${text}` : text));
    },
    onError: (message) => setVoiceNotice(message),
    onNotConfigured: () => {
      setVoiceNotice("Voice input is not configured.");
      onOpenSettings?.("voice");
    },
  });

  const cacheKey = useMemo(
    () => getPresentationViewerCacheKey({ filePath, workspacePath, refreshKey }),
    [filePath, workspacePath, refreshKey],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setCopyMessage("");

    const applyViewerData = (data: ViewerData) => {
      presentationViewerDataCache.set(cacheKey, data);
      setFileData(data);
    };

    const loadFullPreview = () => {
      setRenderingImages(true);
      window.electronAPI
        .readFileForViewer(filePath, workspacePath, { presentationRenderMode: "full" })
        .then((result) => {
          if (cancelled) return;
          if (
            result.success &&
            result.data?.fileType === "pptx" &&
            result.data.presentationPreview
          ) {
            applyViewerData(result.data);
          }
        })
        .catch(() => {
          // The fast text preview remains usable if high-fidelity rendering fails.
        })
        .finally(() => {
          if (!cancelled) setRenderingImages(false);
        });
    };

    const cached = presentationViewerDataCache.get(cacheKey);
    if (cached?.fileType === "pptx" && cached.presentationPreview) {
      setLoading(false);
      applyViewerData(cached);
      if (presentationPreviewNeedsRender(cached.presentationPreview)) {
        loadFullPreview();
      } else {
        setRenderingImages(false);
      }
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setRenderingImages(false);
    setFileData(null);

    window.electronAPI
      .readFileForViewer(filePath, workspacePath, { presentationRenderMode: "fast" })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          setError(result.error || "Failed to load presentation");
          return;
        }
        if (result.data.fileType !== "pptx" || !result.data.presentationPreview) {
          setError("In-app preview is only available for PowerPoint presentations.");
          return;
        }
        applyViewerData(result.data);
        setLoading(false);
        if (presentationPreviewNeedsRender(result.data.presentationPreview)) {
          loadFullPreview();
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load presentation");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, filePath, workspacePath]);

  useEffect(() => {
    if (!copyMessage) return;
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyMessage(""), 2200);
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [copyMessage]);

  const preview = useMemo(() => fileData?.presentationPreview || null, [fileData]);
  const slideCount = preview?.slideCount ?? 0;
  const renderNotice =
    renderingImages || preview?.renderStatus === "rendering" ? "Rendering slide previews..." : "";

  const handleCopyText = async () => {
    const text = buildPresentationText(preview);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage("Copied");
    } catch {
      setCopyMessage("Copy failed");
    }
  };

  const handleOpenExternal = () => {
    void window.electronAPI.openFile(filePath, workspacePath);
  };

  const handleShowInFinder = () => {
    void window.electronAPI.showInFinder(filePath, workspacePath);
  };

  const handleAttachFiles = useCallback(async () => {
    try {
      setAttachmentError("");
      const files = await window.electronAPI.selectFiles(workspacePath);
      if (!files || files.length === 0) return;
      setFullscreenAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          ...file,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })),
      ]);
    } catch {
      setAttachmentError("Failed to add attachments. Please try again.");
    }
  }, [workspacePath]);

  const removeAttachment = useCallback((id: string) => {
    setFullscreenAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const buildMessageWithAttachments = useCallback(
    async (message: string) => {
      if (fullscreenAttachments.length === 0) {
        return { message, images: undefined as ImageAttachment[] | undefined };
      }

      const importedAttachments = workspaceId
        ? await window.electronAPI.importFilesToWorkspace({
            workspaceId,
            files: fullscreenAttachments.map((attachment) => attachment.path),
          })
        : [];
      const attachmentLines =
        importedAttachments.length > 0
          ? importedAttachments.map(
              (attachment) => `- ${attachment.fileName} (${attachment.relativePath})`,
            )
          : fullscreenAttachments.map((attachment) => `- ${attachment.name} (${attachment.path})`);
      const base = message || "Please review the attached files.";
      const images = fullscreenAttachments.filter(isImageAttachment).map((attachment) => ({
        filePath: attachment.path,
        mimeType: attachment.mimeType as ImageAttachment["mimeType"],
        filename: attachment.name,
        sizeBytes: attachment.size,
      }));
      return {
        message: `${base}\n\nAttached files:\n${attachmentLines.join("\n")}`,
        images: images.length > 0 ? images : undefined,
      };
    },
    [fullscreenAttachments, workspaceId],
  );

  const handleFullscreenSend = async () => {
    const message = fullscreenMessage.trim();
    if ((!message && fullscreenAttachments.length === 0) || !onSendMessage || fullscreenSending)
      return;
    const previousMessage = fullscreenMessage;
    const previousAttachments = fullscreenAttachments;
    setFullscreenSending(true);
    setFullscreenMessage("");
    setFullscreenAttachments([]);
    try {
      setAttachmentError("");
      const payload = await buildMessageWithAttachments(message);
      await onSendMessage(payload.message, payload.images);
    } catch {
      setFullscreenMessage(previousMessage);
      setFullscreenAttachments(previousAttachments);
      setAttachmentError("Failed to send message. Please try again.");
    } finally {
      setFullscreenSending(false);
    }
  };

  const renderBody = () => {
    if (loading && !preview)
      return <div className="presentation-artifact-state">Loading presentation...</div>;
    if (error)
      return <div className="presentation-artifact-state presentation-artifact-error">{error}</div>;
    if (!preview)
      return <div className="presentation-artifact-state">No presentation preview available.</div>;
    return (
      <PresentationViewer
        fileName={fileName}
        sizeLabel={fileData ? formatFileSize(fileData.size) : undefined}
        preview={preview}
        onOpenExternal={handleOpenExternal}
        onShowInFinder={handleShowInFinder}
        showExternalActions={false}
        className="presentation-artifact-inner-viewer"
      />
    );
  };

  return (
    <section className={`presentation-artifact-viewer presentation-artifact-viewer-${mode}`}>
      <div className="presentation-artifact-viewer-tabbar">
        <div className="presentation-artifact-viewer-tab">
          <span className="presentation-viewer-file-icon">P</span>
          <span className="presentation-artifact-viewer-tab-title">{fileName}</span>
        </div>
        <button
          type="button"
          className="presentation-artifact-viewer-header-fullscreen"
          onClick={mode === "fullscreen" ? onExitFullscreen : onFullscreen}
          title={fullscreenLabel}
          aria-label={fullscreenLabel}
        >
          {mode === "fullscreen" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="presentation-artifact-viewer-close"
          onClick={onClose}
          title="Close presentation"
        >
          <X size={17} />
        </button>
      </div>

      <div className="presentation-artifact-viewer-titlebar">
        <div className="presentation-artifact-viewer-format">
          {formatLabel}
          {slideCount ? (
            <span>
              {slideCount} slide{slideCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="presentation-artifact-viewer-tool-btn"
          onClick={() => void handleCopyText()}
          disabled={!preview}
          title="Copy slide text and notes"
        >
          <Copy size={14} />
          Copy
        </button>
        <button
          type="button"
          className="presentation-artifact-viewer-tool-btn"
          onClick={handleOpenExternal}
          title="Open externally"
        >
          <ExternalLink size={14} />
          Open
        </button>
        <button
          type="button"
          className="presentation-artifact-viewer-tool-btn"
          onClick={handleShowInFinder}
          title="Open in folder"
        >
          <FolderOpen size={14} />
          Folder
        </button>
        {(copyMessage || renderNotice) && (
          <div className="presentation-artifact-viewer-message">{copyMessage || renderNotice}</div>
        )}
      </div>

      <div className="presentation-artifact-viewer-content">{renderBody()}</div>

      {mode === "fullscreen" && onSendMessage && (
        <div className="spreadsheet-viewer-fullscreen-controls">
          {turnContext && (
            <div
              className={`spreadsheet-viewer-turn-frame ${
                turnContextExpanded ? "expanded" : "collapsed"
              }`}
            >
              <button
                type="button"
                className="spreadsheet-viewer-turn-header"
                onClick={() => setTurnContextExpanded((current) => !current)}
                aria-expanded={turnContextExpanded}
              >
                <span>{turnContext.statusLabel}</span>
                <ChevronDown size={18} aria-hidden="true" />
              </button>
              {turnContextExpanded && (
                <div className="spreadsheet-viewer-turn-body">
                  <p>{turnContext.summary}</p>
                  {turnContext.secondaryText && (
                    <p className="spreadsheet-viewer-turn-secondary">{turnContext.secondaryText}</p>
                  )}
                  {turnContext.events && turnContext.events.length > 0 && (
                    <div className="spreadsheet-viewer-turn-events">
                      {turnContext.events.map((event) => (
                        <div
                          key={event.id}
                          className={`spreadsheet-viewer-turn-event kind-${event.kind} ${
                            event.tone ? `tone-${event.tone}` : ""
                          }`}
                        >
                          <span className="spreadsheet-viewer-turn-event-text">{event.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <PresentationArtifactCard
                    filePath={turnContext.artifactPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onExitFullscreen}
                  />
                </div>
              )}
            </div>
          )}
          <div className="spreadsheet-viewer-composer">
            {(fullscreenAttachments.length > 0 || attachmentError || voiceNotice) && (
              <div className="attachment-panel spreadsheet-viewer-attachment-panel">
                {attachmentError && <div className="attachment-error">{attachmentError}</div>}
                {voiceNotice && <div className="attachment-error">{voiceNotice}</div>}
                {fullscreenAttachments.length > 0 && (
                  <div className="attachment-list">
                    {fullscreenAttachments.map((attachment) => (
                      <div className="attachment-chip" key={attachment.id}>
                        <span className="attachment-name" title={attachment.name}>
                          {attachment.name}
                        </span>
                        <span className="attachment-size">
                          {formatAttachmentSize(attachment.size)}
                        </span>
                        <button
                          type="button"
                          className="attachment-remove"
                          onClick={() => removeAttachment(attachment.id)}
                          title="Remove attachment"
                          disabled={fullscreenSending}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="input-container spreadsheet-viewer-composer-input">
              <div className="input-row">
                <button
                  type="button"
                  className="attachment-btn attachment-btn-left"
                  title="Attach files"
                  aria-label="Attach files"
                  onClick={() => void handleAttachFiles()}
                  disabled={fullscreenSending}
                >
                  <Plus size={22} aria-hidden="true" />
                </button>
                <div className="mention-autocomplete-wrapper">
                  <textarea
                    className="input-field input-textarea"
                    placeholder="Ask for follow-up changes"
                    value={fullscreenMessage}
                    rows={1}
                    onChange={(event) => setFullscreenMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void handleFullscreenSend();
                      }
                    }}
                  />
                </div>
                <div className="input-actions">
                  {selectedModel &&
                  selectedProvider &&
                  onModelChange &&
                  availableModels.length > 0 ? (
                    <ModelDropdown
                      models={availableModels}
                      selectedModel={selectedModel}
                      selectedProvider={selectedProvider}
                      selectedReasoningEffort={selectedReasoningEffort}
                      providers={availableProviders}
                      onModelChange={onModelChange}
                      onOpenSettings={onOpenSettings}
                      variant="label"
                      align="right"
                    />
                  ) : selectedModelLabel ? (
                    <span className="spreadsheet-viewer-composer-model">{selectedModelLabel}</span>
                  ) : null}
                  <button
                    type="button"
                    className={`voice-input-btn ${voiceInput.state}`}
                    onClick={() => void voiceInput.toggleRecording()}
                    disabled={voiceInput.state === "processing" || fullscreenSending}
                    title="Voice input"
                  >
                    {voiceInput.state === "recording" ? (
                      <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    ) : (
                      <Mic size={16} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="lets-go-btn lets-go-btn-sm"
                    onClick={() => void handleFullscreenSend()}
                    disabled={
                      (!fullscreenMessage.trim() && fullscreenAttachments.length === 0) ||
                      fullscreenSending
                    }
                    title="Send message"
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
            <div className="input-below-actions spreadsheet-viewer-composer-actions">
              <span className="input-status-workspace">Work in a folder</span>
              <span className="input-status-mode">Execute</span>
              <span className="input-status-mode">Auto</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
