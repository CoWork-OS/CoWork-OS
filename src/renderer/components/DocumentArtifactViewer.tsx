import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  ArrowUp,
  Bold,
  Copy,
  ExternalLink,
  FolderOpen,
  Italic,
  List,
  ListOrdered,
  Maximize2,
  Mic,
  Minimize2,
  Plus,
  Redo2,
  Save,
  Square,
  Underline,
  Undo2,
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
import type {
  DocumentPreview,
  EditableDocumentBlock,
  EditableDocumentRun,
} from "../../shared/document-preview";
import { getDocumentFormatLabel } from "../../shared/document-formats";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { ModelDropdown } from "./MainContent";
import type { SpreadsheetTurnContext } from "./SpreadsheetArtifactViewer";
import { DocumentArtifactCard } from "./DocumentArtifactCard";
import { ChevronDown } from "lucide-react";

type DocumentArtifactViewerMode = "sidebar" | "fullscreen";
type DocumentSettingsTab = Any;
type PendingDocumentAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType?: string;
};

type DocumentArtifactViewerProps = {
  filePath: string;
  workspacePath: string;
  mode: DocumentArtifactViewerMode;
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
  onOpenSettings?: (tab?: DocumentSettingsTab) => void;
  turnContext?: SpreadsheetTurnContext | null;
  refreshKey?: string | number | null;
};

type ViewerData = NonNullable<FileViewerResult["data"]>;

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

function isImageAttachment(attachment: PendingDocumentAttachment): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
    attachment.mimeType || "",
  );
}

function buildFallbackPreview(data: ViewerData): DocumentPreview {
  const format = getDocumentFormatLabel(data.fileName);
  if (data.htmlContent) {
    return {
      format,
      previewMode: "html",
      text: data.content || "",
      htmlContent: data.htmlContent,
      canEdit: data.fileType === "docx",
      conversionStatus: "native",
    };
  }
  return {
    format,
    previewMode: data.content ? "text" : "unavailable",
    text: data.content || "",
    canEdit: data.fileType === "docx",
    conversionStatus: data.content ? "native" : "unavailable",
    conversionMessage: data.content ? undefined : "No in-app document preview is available.",
  };
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p>${paragraph
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function blockText(block: EditableDocumentBlock): string {
  return block.runs?.map((run) => run.text).join("") || block.text || "";
}

function renderEditableDocumentHtml(blocks: EditableDocumentBlock[] | undefined): string {
  if (!blocks?.length) return "";
  return blocks
    .map((block) => {
      const attrs = [
        block.id ? `data-block-id="${escapeHtml(block.id)}"` : "",
        typeof block.order === "number" ? `data-block-order="${block.order}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (block.type === "table") {
        const rows = block.rows || [];
        return `<table ${attrs}>${rows
          .map((row) =>
            `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
          )
          .join("")}</table>`;
      }
      if (block.type === "heading") {
        const level = Math.min(Math.max(block.level || 1, 1), 6);
        return `<h${level} ${attrs}>${escapeHtml(blockText(block))}</h${level}>`;
      }
      return `<p ${attrs}>${escapeHtml(blockText(block))}</p>`;
    })
    .join("");
}

function extractRunsFromNode(
  node: Node,
  inherited: Omit<EditableDocumentRun, "text"> = {},
): EditableDocumentRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    return text ? [{ ...inherited, text }] : [];
  }
  if (!(node instanceof HTMLElement)) return [];
  const tagName = node.tagName.toUpperCase();
  const next = {
    ...inherited,
    bold: inherited.bold || tagName === "B" || tagName === "STRONG",
    italic: inherited.italic || tagName === "I" || tagName === "EM",
    underline: inherited.underline || tagName === "U",
  };
  if (tagName === "BR") return [{ ...next, text: "\n" }];
  return Array.from(node.childNodes).flatMap((child) => extractRunsFromNode(child, next));
}

function collapseRuns(runs: EditableDocumentRun[]): EditableDocumentRun[] {
  const collapsed: EditableDocumentRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = collapsed[collapsed.length - 1];
    if (
      previous &&
      Boolean(previous.bold) === Boolean(run.bold) &&
      Boolean(previous.italic) === Boolean(run.italic) &&
      Boolean(previous.underline) === Boolean(run.underline)
    ) {
      previous.text += run.text;
    } else {
      collapsed.push({ ...run });
    }
  }
  return collapsed;
}

function blockFromElement(element: HTMLElement): EditableDocumentBlock[] {
  const tagName = element.tagName.toUpperCase();
  const blockIdentity = {
    id: element.dataset.blockId || undefined,
    order: element.dataset.blockOrder ? Number(element.dataset.blockOrder) : undefined,
  };
  if (tagName === "UL" || tagName === "OL") {
    return Array.from(element.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .filter((child) => child.tagName.toUpperCase() === "LI")
      .map((child) => ({
        id: child.dataset.blockId || undefined,
        order: child.dataset.blockOrder ? Number(child.dataset.blockOrder) : undefined,
        type: tagName === "UL" ? "bullet" : "numbered",
        runs: collapseRuns(extractRunsFromNode(child)),
      }));
  }
  if (tagName === "TABLE") {
    return [
      {
        ...blockIdentity,
        type: "table",
        rows: Array.from(element.querySelectorAll("tr")).map((row) =>
          Array.from(row.querySelectorAll("th,td")).map((cell) =>
            (cell.textContent || "").replace(/\s+/g, " ").trim(),
          ),
        ),
      },
    ];
  }
  if (tagName === "DIV" && Array.from(element.children).some((child) =>
    ["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "TABLE"].includes(child.tagName.toUpperCase())
  )) {
    return Array.from(element.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .flatMap(blockFromElement);
  }
  if (/^H[1-6]$/.test(tagName)) {
    return [
      {
        ...blockIdentity,
        type: "heading",
        level: Number(tagName.slice(1)),
        runs: collapseRuns(extractRunsFromNode(element)),
      },
    ];
  }
  return [
    {
      ...blockIdentity,
      type: "paragraph",
      runs: collapseRuns(extractRunsFromNode(element)),
    },
  ];
}

function extractEditableDocumentBlocks(root: HTMLElement): EditableDocumentBlock[] {
  const blocks = Array.from(root.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .flatMap(blockFromElement)
    .filter((block) => {
      if (block.type === "table") return Boolean(block.rows?.length);
      return Boolean(block.runs?.some((run) => run.text.trim().length > 0));
    });
  return blocks.length > 0 ? blocks : [{ type: "paragraph", runs: [{ text: "" }] }];
}

export function DocumentArtifactViewer({
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
}: DocumentArtifactViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ViewerData | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorInitializedKey, setEditorInitializedKey] = useState("");
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const [fullscreenSending, setFullscreenSending] = useState(false);
  const [fullscreenAttachments, setFullscreenAttachments] = useState<
    PendingDocumentAttachment[]
  >([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [turnContextExpanded, setTurnContextExpanded] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileName = fileData?.fileName || getFileName(filePath);
  const fullscreenLabel = mode === "fullscreen" ? "Exit full screen" : "Open document in full screen";
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceNotice("");
      setFullscreenMessage((current) => current ? `${current} ${text}` : text);
    },
    onError: (message) => setVoiceNotice(message),
    onNotConfigured: () => {
      setVoiceNotice("Voice input is not configured.");
      onOpenSettings?.("voice");
    },
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFileData(null);
    setCopyMessage("");
    setDirty(false);
    setEditorInitializedKey("");

    window.electronAPI
      .readFileForViewer(filePath, workspacePath)
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          setError(result.error || "Failed to load document");
          return;
        }
        if (result.data.fileType !== "docx" && result.data.fileType !== "document") {
          setError("File is not a Word-style document.");
          return;
        }
        setFileData(result.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load document");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, workspacePath, refreshKey]);

  useEffect(() => {
    if (!copyMessage) return;
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyMessage(""), 2200);
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [copyMessage]);

  const preview = useMemo(() => {
    if (!fileData) return null;
    return fileData.documentPreview || buildFallbackPreview(fileData);
  }, [fileData]);

  const formatLabel = preview?.format || getDocumentFormatLabel(fileName);
  const canEditDirectly = Boolean(preview?.canEdit && fileData?.fileType === "docx");

  useEffect(() => {
    if (!canEditDirectly || !preview || !editorRef.current) return;
    const key = `${filePath}:${preview.htmlContent || preview.text}`;
    if (editorInitializedKey === key) return;
    editorRef.current.innerHTML =
      renderEditableDocumentHtml(preview.blocks as EditableDocumentBlock[] | undefined) ||
      preview.htmlContent ||
      textToHtml(preview.text || "");
    setEditorInitializedKey(key);
    setDirty(false);
  }, [canEditDirectly, editorInitializedKey, filePath, preview]);

  const handleCopyText = async () => {
    const text = preview?.text || "";
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

  const runEditorCommand = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    setDirty(true);
  };

  const handleSaveDocument = async () => {
    if (!editorRef.current || saving || !canEditDirectly) return;
    setSaving(true);
    setCopyMessage("");
    try {
      const blocks = extractEditableDocumentBlocks(editorRef.current);
      const result = await window.electronAPI.updateDocumentFile({
        filePath,
        workspacePath,
        blocks,
      });
      if (!result.success || !result.data) {
        setCopyMessage(result.error || "Save failed");
        return;
      }
      setFileData(result.data);
      setDirty(false);
      setCopyMessage("Saved");
      setEditorInitializedKey("");
    } catch (err: unknown) {
      setCopyMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
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
    setFullscreenAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }, []);

  const buildMessageWithAttachments = useCallback(async (message: string) => {
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
    const images = fullscreenAttachments
      .filter(isImageAttachment)
      .map((attachment) => ({
        filePath: attachment.path,
        mimeType: attachment.mimeType as ImageAttachment["mimeType"],
        filename: attachment.name,
        sizeBytes: attachment.size,
      }));
    return {
      message: `${base}\n\nAttached files:\n${attachmentLines.join("\n")}`,
      images: images.length > 0 ? images : undefined,
    };
  }, [fullscreenAttachments, workspaceId]);

  const handleFullscreenSend = async () => {
    const message = fullscreenMessage.trim();
    if ((!message && fullscreenAttachments.length === 0) || !onSendMessage || fullscreenSending) return;
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

  const renderDocumentBody = () => {
    if (loading) return <div className="document-viewer-state">Loading document...</div>;
    if (error) return <div className="document-viewer-state document-viewer-error">{error}</div>;
    if (!preview) return <div className="document-viewer-state">No document preview available.</div>;
    if (preview.previewMode === "unavailable") {
      return (
        <div className="document-viewer-state">
          <strong>Preview unavailable</strong>
          <p>{preview.conversionMessage || "Open this document in its native app to review it."}</p>
          <button type="button" className="document-viewer-tool-btn" onClick={handleOpenExternal}>
            <ExternalLink size={14} />
            Open externally
          </button>
        </div>
      );
    }
    if (canEditDirectly) {
      return (
        <div className="document-editor-canvas">
          <div
            ref={editorRef}
            className="document-editor-page"
            contentEditable
            suppressContentEditableWarning
            spellCheck
            onInput={() => setDirty(true)}
            onBlur={() => setDirty(true)}
          />
        </div>
      );
    }
    if (preview.previewMode === "html" && preview.htmlContent) {
      return (
        <div
          className="document-viewer-html"
          dangerouslySetInnerHTML={{ __html: preview.htmlContent }}
        />
      );
    }
    return <pre className="document-viewer-text">{preview.text || "Empty document."}</pre>;
  };

  return (
    <section className={`document-viewer document-viewer-${mode}`}>
      <div className="document-viewer-tabbar">
        <div className="document-viewer-tab">
          <span className="document-viewer-file-icon">W</span>
          <span className="document-viewer-tab-title">{fileName}</span>
        </div>
        <button
          type="button"
          className="document-viewer-header-fullscreen"
          onClick={mode === "fullscreen" ? onExitFullscreen : onFullscreen}
          title={fullscreenLabel}
          aria-label={fullscreenLabel}
        >
          {mode === "fullscreen" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="document-viewer-close"
          onClick={onClose}
          title="Close document"
        >
          <X size={17} />
        </button>
      </div>

      <div className={`document-viewer-titlebar ${canEditDirectly ? "is-editor-toolbar" : ""}`}>
        {canEditDirectly ? (
          <>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("undo")} title="Undo">
              <Undo2 size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("redo")} title="Redo">
              <Redo2 size={15} />
            </button>
            <select
              className="document-viewer-select"
              defaultValue="p"
              onChange={(event) => runEditorCommand("formatBlock", event.target.value)}
              title="Text style"
            >
              <option value="p">Normal text</option>
              <option value="h1">Title</option>
              <option value="h2">Heading</option>
              <option value="h3">Subheading</option>
            </select>
            <select
              className="document-viewer-select"
              defaultValue="Arial"
              onChange={(event) => runEditorCommand("fontName", event.target.value)}
              title="Font"
            >
              <option value="Arial">Arial</option>
              <option value="Helvetica">Helvetica</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Georgia">Georgia</option>
              <option value="Courier New">Courier New</option>
            </select>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("fontSize", "2")} title="Smaller text">-</button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("fontSize", "3")} title="Normal size">11</button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("fontSize", "4")} title="Larger text">+</button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("bold")} title="Bold">
              <Bold size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("italic")} title="Italic">
              <Italic size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("underline")} title="Underline">
              <Underline size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("justifyLeft")} title="Align left">
              <AlignLeft size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("insertUnorderedList")} title="Bulleted list">
              <List size={15} />
            </button>
            <button type="button" className="document-viewer-icon-tool" onClick={() => runEditorCommand("insertOrderedList")} title="Numbered list">
              <ListOrdered size={15} />
            </button>
            <button
              type="button"
              className="document-viewer-save-btn"
              onClick={() => void handleSaveDocument()}
              disabled={!dirty || saving}
              title="Save document"
            >
              <Save size={15} />
              {saving ? "Saving" : "Save"}
            </button>
            {copyMessage && <div className="document-viewer-save-message">{copyMessage}</div>}
          </>
        ) : (
          <>
            <div className="document-viewer-format">{formatLabel}</div>
            <button
              type="button"
              className="document-viewer-tool-btn"
              onClick={() => void handleCopyText()}
              disabled={!preview?.text}
              title="Copy document text"
            >
              <Copy size={14} />
              Copy
            </button>
            <button
              type="button"
              className="document-viewer-tool-btn"
              onClick={handleOpenExternal}
              title="Open externally"
            >
              <ExternalLink size={14} />
              Open
            </button>
            <button
              type="button"
              className="document-viewer-tool-btn"
              onClick={handleShowInFinder}
              title="Open in folder"
            >
              <FolderOpen size={14} />
              Folder
            </button>
            {copyMessage && <div className="document-viewer-save-message">{copyMessage}</div>}
          </>
        )}
      </div>

      <div className="document-viewer-content">{renderDocumentBody()}</div>

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
                    <p className="spreadsheet-viewer-turn-secondary">
                      {turnContext.secondaryText}
                    </p>
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
                          <span className="spreadsheet-viewer-turn-event-text">
                            {event.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <DocumentArtifactCard
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
                        <span className="attachment-size">{formatAttachmentSize(attachment.size)}</span>
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
              <span className="shell-toggle shell-toggle-inline enabled">
                Shell
                <span className="goal-mode-switch-track on">
                  <span className="goal-mode-switch-thumb" />
                </span>
              </span>
              <span className="input-status-mode">Execute</span>
              <span className="input-status-mode">Auto</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
