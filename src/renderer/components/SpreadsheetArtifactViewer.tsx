import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { ArrowUp, ChevronDown, Copy, Maximize2, Mic, Minimize2, Plus, Save, Square, X } from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";
import type {
  ImageAttachment,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../shared/types";
import {
  spreadsheetColumnLetter,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
} from "../../shared/spreadsheet-preview";
import { getSpreadsheetFormatLabel } from "../../shared/spreadsheet-formats";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { ModelDropdown } from "./MainContent";
import { SpreadsheetArtifactCard } from "./SpreadsheetArtifactCard";

type SpreadsheetArtifactViewerMode = "sidebar" | "fullscreen";
type SpreadsheetSettingsTab =
  | "appearance"
  | "llm"
  | "search"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "x"
  | "morechannels"
  | "integrations"
  | "updates"
  | "system"
  | "queue"
  | "skills"
  | "voice"
  | "scheduled"
  | "mcp"
  | "agents"
  | "github"
  | "notifications";
type PendingSpreadsheetAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType?: string;
};

export type SpreadsheetTurnContext = {
  statusLabel: string;
  summary: string;
  secondaryText?: string;
  artifactPath: string;
  artifactName: string;
  events?: Array<{
    id: string;
    kind: "step" | "assistant";
    text: string;
    tone?: "muted" | "active" | "done";
  }>;
};

type SpreadsheetArtifactViewerProps = {
  filePath: string;
  workspacePath: string;
  mode: SpreadsheetArtifactViewerMode;
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
  onOpenSettings?: (tab?: SpreadsheetSettingsTab) => void;
  turnContext?: SpreadsheetTurnContext | null;
};

type ViewerData = NonNullable<FileViewerResult["data"]>;
type CellPosition = { row: number; column: number };
type CellRange = { start: CellPosition; end: CellPosition };
const ZOOM_OPTIONS = [50, 75, 90, 100, 125, 150, 200] as const;
const MAX_EDITABLE_COLUMNS = 200;

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

function isImageAttachment(attachment: PendingSpreadsheetAttachment): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
    attachment.mimeType || "",
  );
}

function getWorkbookTitle(fileName: string): string {
  return fileName.replace(/\.(xlsx?|xlsm|csv|tsv)$/i, "");
}

function getCellStyle(cell: SpreadsheetPreviewCell): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (cell.bold) style.fontWeight = 700;
  if (cell.italic) style.fontStyle = "italic";
  if (cell.backgroundColor) style.backgroundColor = cell.backgroundColor;
  if (cell.fontColor) style.color = cell.fontColor;
  if (cell.horizontalAlignment) style.textAlign = cell.horizontalAlignment as CSSProperties["textAlign"];
  return Object.keys(style).length > 0 ? style : undefined;
}

function clonePreview(preview: SpreadsheetPreview): SpreadsheetPreview {
  return JSON.parse(JSON.stringify(preview)) as SpreadsheetPreview;
}

function createCell(row: number, column: number): SpreadsheetPreviewCell {
  return {
    address: `${spreadsheetColumnLetter(column - 1)}${row}`,
    row,
    column,
    value: "",
  };
}

function ensureSheetBounds(
  sheet: SpreadsheetPreview["sheets"][number],
  minRows: number,
  minColumns: number,
): void {
  const targetRows = Math.max(sheet.rowCount || 0, minRows);
  const targetColumns = Math.min(
    MAX_EDITABLE_COLUMNS,
    Math.max(sheet.columnCount || 0, minColumns),
  );
  while (sheet.rows.length < targetRows) {
    const rowNumber = sheet.rows.length + 1;
    sheet.rows.push(Array.from({ length: targetColumns }, (_, index) => createCell(rowNumber, index + 1)));
  }
  for (let rowIndex = 0; rowIndex < targetRows; rowIndex += 1) {
    const row = sheet.rows[rowIndex] || [];
    while (row.length < targetColumns) {
      row.push(createCell(rowIndex + 1, row.length + 1));
    }
    sheet.rows[rowIndex] = row;
  }
  while (sheet.columnWidths.length < targetColumns) {
    sheet.columnWidths.push(12);
  }
  sheet.rowCount = targetRows;
  sheet.columnCount = targetColumns;
}

function getCellText(cell: SpreadsheetPreviewCell | null): string {
  if (!cell) return "";
  if (cell.formula) return `=${cell.formula}`;
  return cell.value || "";
}

function getCellDisplayText(cell: SpreadsheetPreviewCell | undefined): string {
  if (!cell) return "";
  if (cell.formula && cell.value.startsWith("=")) return cell.value;
  return cell.value || "";
}

function normalizeRange(range: CellRange | null): CellRange | null {
  if (!range) return null;
  return {
    start: {
      row: Math.min(range.start.row, range.end.row),
      column: Math.min(range.start.column, range.end.column),
    },
    end: {
      row: Math.max(range.start.row, range.end.row),
      column: Math.max(range.start.column, range.end.column),
    },
  };
}

function cellIsInRange(range: CellRange | null, row: number, column: number): boolean {
  const normalized = normalizeRange(range);
  if (!normalized) return false;
  return (
    row >= normalized.start.row &&
    row <= normalized.end.row &&
    column >= normalized.start.column &&
    column <= normalized.end.column
  );
}

function buildFallbackPreview(data: ViewerData): SpreadsheetPreview | null {
  if (!data.content) return null;
  const sheets = data.content.split("\n\n").map((block) => {
    const lines = block.split("\n");
    const hasSheetHeader = lines[0]?.startsWith("## Sheet: ");
    const name = hasSheetHeader ? lines[0].replace("## Sheet: ", "") : "Sheet";
    const rowLines = hasSheetHeader ? lines.slice(1) : lines;
    const rawRows = rowLines.filter((line) => line.length > 0).map((line) => line.split("\t"));
    const columnCount = Math.max(...rawRows.map((row) => row.length), 0);
    return {
      name,
      rowCount: rawRows.length,
      columnCount,
      columnWidths: Array.from({ length: columnCount }, () => 12),
      rows: rawRows.map((row, rowIndex) =>
        Array.from({ length: columnCount }, (_, columnIndex) => ({
          address: `${spreadsheetColumnLetter(columnIndex)}${rowIndex + 1}`,
          row: rowIndex + 1,
          column: columnIndex + 1,
          value: row[columnIndex] || "",
        })),
      ),
    };
  });
  return {
    activeSheetName: sheets[0]?.name,
    sheetCount: sheets.length,
    sheets,
  };
}

export function SpreadsheetArtifactViewer({
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
}: SpreadsheetArtifactViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ViewerData | null>(null);
  const [editablePreview, setEditablePreview] = useState<SpreadsheetPreview | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>({
    row: 1,
    column: 1,
  });
  const [selectedRange, setSelectedRange] = useState<CellRange | null>({
    start: { row: 1, column: 1 },
    end: { row: 1, column: 1 },
  });
  const [editingCell, setEditingCell] = useState<CellPosition | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [zoom, setZoom] = useState<(typeof ZOOM_OPTIONS)[number]>(100);
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const [fullscreenSending, setFullscreenSending] = useState(false);
  const [fullscreenAttachments, setFullscreenAttachments] = useState<
    PendingSpreadsheetAttachment[]
  >([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [turnContextExpanded, setTurnContextExpanded] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const fileName = fileData?.fileName || getFileName(filePath);
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceNotice("");
      setFullscreenMessage((current) => current ? `${current} ${text}` : text);
    },
    onError: (message) => {
      setVoiceNotice(message);
    },
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
    setEditablePreview(null);
    setActiveSheetIndex(0);
    setSelectedCell({ row: 1, column: 1 });
    setSelectedRange({ start: { row: 1, column: 1 }, end: { row: 1, column: 1 } });
    setEditingCell(null);
    setDirty(false);
    setSaveMessage("");

    window.electronAPI
      .readFileForViewer(filePath, workspacePath)
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          setError(result.error || "Failed to load spreadsheet");
          return;
        }
        if (result.data.fileType !== "xlsx" && result.data.fileType !== "csv") {
          setError("File is not a spreadsheet.");
          return;
        }
        setFileData(result.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load spreadsheet");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, workspacePath]);

  const preview = useMemo(() => {
    if (!fileData) return null;
    return fileData.spreadsheetPreview || buildFallbackPreview(fileData);
  }, [fileData]);

  useEffect(() => {
    setEditablePreview(preview ? clonePreview(preview) : null);
  }, [preview]);

  useEffect(() => {
    if (saveMessage !== "Copied" && saveMessage !== "Saved") return;
    const timeout = window.setTimeout(() => {
      setSaveMessage((current) => (current === saveMessage ? "" : current));
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [saveMessage]);

  const activeSheet = editablePreview?.sheets[activeSheetIndex] || editablePreview?.sheets[0] || null;
  const selected =
    activeSheet && selectedCell
      ? activeSheet.rows[selectedCell.row - 1]?.[selectedCell.column - 1] || null
      : null;
  const selectedAddress = selectedCell
    ? `${spreadsheetColumnLetter(selectedCell.column - 1)}${selectedCell.row}`
    : "A1";
  const formulaText = getCellText(selected);
  const zoomScale = zoom / 100;
  const visibleColumnCount = Math.max(activeSheet?.columnCount || 0, mode === "fullscreen" ? 10 : 4);
  const visibleRowCount = Math.max(activeSheet?.rowCount || 0, mode === "fullscreen" ? 26 : 18);
  const normalizedSelectedRange = normalizeRange(selectedRange);
  const fullscreenLabel = mode === "fullscreen" ? "Exit full screen" : "Open spreadsheet in full screen";
  const formatLabel = getSpreadsheetFormatLabel(fileName);

  const selectCell = (position: CellPosition, extend = false) => {
    setSelectedCell(position);
    setSelectedRange((current) => {
      if (!extend) return { start: position, end: position };
      const start = current?.start || selectedCell || position;
      return { start, end: position };
    });
    setEditingCell(null);
  };

  const selectRange = (range: CellRange, active: CellPosition = range.start) => {
    setSelectedCell(active);
    setSelectedRange(range);
    setEditingCell(null);
    gridRef.current?.focus();
  };

  const selectColumn = (column: number) => {
    selectRange(
      {
        start: { row: 1, column },
        end: { row: Math.max(activeSheet?.rowCount || visibleRowCount, 1), column },
      },
      { row: 1, column },
    );
  };

  const selectRow = (row: number) => {
    selectRange(
      {
        start: { row, column: 1 },
        end: { row, column: Math.max(activeSheet?.columnCount || visibleColumnCount, 1) },
      },
      { row, column: 1 },
    );
  };

  const selectAllVisibleSheet = () => {
    selectRange({
      start: { row: 1, column: 1 },
      end: {
        row: Math.max(activeSheet?.rowCount || visibleRowCount, 1),
        column: Math.max(activeSheet?.columnCount || visibleColumnCount, 1),
      },
    });
  };

  const getSelectedRangeText = () => {
    if (!activeSheet || !normalizedSelectedRange) return "";
    const lines: string[] = [];
    for (let row = normalizedSelectedRange.start.row; row <= normalizedSelectedRange.end.row; row += 1) {
      const values: string[] = [];
      for (
        let column = normalizedSelectedRange.start.column;
        column <= normalizedSelectedRange.end.column;
        column += 1
      ) {
        values.push(getCellText(activeSheet.rows[row - 1]?.[column - 1] || null));
      }
      lines.push(values.join("\t"));
    }
    return lines.join("\n");
  };

  const copySelectionToClipboard = async () => {
    const text = getSelectedRangeText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setSaveMessage("Copied");
    } catch {
      setSaveMessage("Copy failed");
    }
  };

  const updateCellValue = (row: number, column: number, value: string) => {
    setEditablePreview((current) => {
      if (!current) return current;
      const next = clonePreview(current);
      const sheet = next.sheets[activeSheetIndex] || next.sheets[0];
      if (!sheet) return current;
      ensureSheetBounds(sheet, row, column);
      const cell = sheet.rows[row - 1][column - 1] || createCell(row, column);
      if (value.startsWith("=")) {
        cell.formula = value.slice(1);
        cell.value = value;
      } else {
        delete cell.formula;
        cell.value = value;
      }
      sheet.rows[row - 1][column - 1] = cell;
      next.activeSheetName = sheet.name;
      return next;
    });
    setDirty(true);
    setSaveMessage("");
  };

  const startEditing = (position: CellPosition, initialValue?: string) => {
    const cell = activeSheet?.rows[position.row - 1]?.[position.column - 1] || null;
    setSelectedCell(position);
    setSelectedRange({ start: position, end: position });
    setEditingCell(position);
    setEditingValue(initialValue ?? getCellText(cell));
  };

  const commitEditing = () => {
    if (!editingCell) return;
    updateCellValue(editingCell.row, editingCell.column, editingValue);
    setEditingCell(null);
    setEditingValue("");
    gridRef.current?.focus();
  };

  const cancelEditing = () => {
    setEditingCell(null);
    setEditingValue("");
    gridRef.current?.focus();
  };

  const moveSelection = (deltaRow: number, deltaColumn: number) => {
    const current = selectedCell || { row: 1, column: 1 };
    const position = {
      row: Math.max(1, current.row + deltaRow),
      column: Math.max(1, current.column + deltaColumn),
    };
    selectCell(position);
  };

  const addRows = (count = 1) => {
    setEditablePreview((current) => {
      if (!current) return current;
      const next = clonePreview(current);
      const sheet = next.sheets[activeSheetIndex] || next.sheets[0];
      if (!sheet) return current;
      ensureSheetBounds(sheet, (sheet.rowCount || 0) + count, Math.max(sheet.columnCount || 1, 1));
      return next;
    });
    setDirty(true);
  };

  const addColumns = (count = 1) => {
    if ((activeSheet?.columnCount || 0) >= MAX_EDITABLE_COLUMNS) return;
    setEditablePreview((current) => {
      if (!current) return current;
      const next = clonePreview(current);
      const sheet = next.sheets[activeSheetIndex] || next.sheets[0];
      if (!sheet) return current;
      if ((sheet.columnCount || 0) >= MAX_EDITABLE_COLUMNS) return current;
      ensureSheetBounds(sheet, Math.max(sheet.rowCount || 1, 1), (sheet.columnCount || 0) + count);
      return next;
    });
    setDirty(true);
  };

  const pasteTabularData = (text: string) => {
    if (!selectedCell || !text.trim()) return;
    const rows = text.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
    setEditablePreview((current) => {
      if (!current) return current;
      const next = clonePreview(current);
      const sheet = next.sheets[activeSheetIndex] || next.sheets[0];
      if (!sheet) return current;
      const values = rows.map((line) => line.split("\t"));
      ensureSheetBounds(
        sheet,
        selectedCell.row + values.length - 1,
        selectedCell.column + Math.max(...values.map((row) => row.length), 1) - 1,
      );
      values.forEach((rowValues, rowOffset) => {
        rowValues.forEach((value, columnOffset) => {
          const row = selectedCell.row + rowOffset;
          const column = selectedCell.column + columnOffset;
          const cell = sheet.rows[row - 1][column - 1] || createCell(row, column);
          if (value.startsWith("=")) {
            cell.formula = value.slice(1);
            cell.value = value;
          } else {
            delete cell.formula;
            cell.value = value;
          }
          sheet.rows[row - 1][column - 1] = cell;
        });
      });
      return next;
    });
    setDirty(true);
    setSaveMessage("");
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editingCell) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelectionToClipboard();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllVisibleSheet();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (event.shiftKey && selectedCell) {
        selectCell({ row: Math.max(1, selectedCell.row - 1), column: selectedCell.column }, true);
      } else {
        moveSelection(-1, 0);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.shiftKey && selectedCell) {
        selectCell({ row: selectedCell.row + 1, column: selectedCell.column }, true);
      } else {
        moveSelection(1, 0);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (event.shiftKey && selectedCell) {
        selectCell({ row: selectedCell.row, column: Math.max(1, selectedCell.column - 1) }, true);
      } else {
        moveSelection(0, -1);
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (event.shiftKey && selectedCell) {
        selectCell({ row: selectedCell.row, column: selectedCell.column + 1 }, true);
      } else {
        moveSelection(0, 1);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      startEditing(selectedCell || { row: 1, column: 1 });
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      const position = selectedCell || { row: 1, column: 1 };
      updateCellValue(position.row, position.column, "");
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      startEditing(selectedCell || { row: 1, column: 1 }, event.key);
    }
  };

  const handleSave = async () => {
    if (!editablePreview || saving) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const result = await window.electronAPI.updateSpreadsheetFile({
        filePath,
        workspacePath,
        preview: editablePreview,
      });
      if (!result.success || !result.data) {
        setSaveMessage(result.error || "Save failed");
        return;
      }
      setFileData(result.data);
      setEditablePreview(result.data.spreadsheetPreview || editablePreview);
      setDirty(false);
      setSaveMessage("Saved");
    } catch (err: unknown) {
      setSaveMessage(err instanceof Error ? err.message : "Save failed");
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
    const attachedMessage = `${base}\n\nAttached files:\n${attachmentLines.join("\n")}`;
    const images = fullscreenAttachments
      .filter(isImageAttachment)
      .map((attachment) => ({
        filePath: attachment.path,
        mimeType: attachment.mimeType as ImageAttachment["mimeType"],
        filename: attachment.name,
        sizeBytes: attachment.size,
      }));

    return {
      message: attachedMessage,
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

  return (
    <section className={`spreadsheet-viewer spreadsheet-viewer-${mode}`}>
      <div className="spreadsheet-viewer-tabbar">
        <div className="spreadsheet-viewer-tab">
          <span className="spreadsheet-viewer-file-icon">X</span>
          <span className="spreadsheet-viewer-tab-title">{fileName}</span>
        </div>
        <button
          type="button"
          className="spreadsheet-viewer-header-fullscreen"
          onClick={mode === "fullscreen" ? onExitFullscreen : onFullscreen}
          title={fullscreenLabel}
          aria-label={fullscreenLabel}
        >
          {mode === "fullscreen" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="spreadsheet-viewer-close"
          onClick={onClose}
          title="Close spreadsheet"
        >
          <X size={17} />
        </button>
      </div>

      <div className="spreadsheet-viewer-titlebar">
        <div className="spreadsheet-viewer-format">{formatLabel}</div>
        <label className="spreadsheet-viewer-zoom" title="Zoom">
          <select
            value={zoom}
            onChange={(event) => {
              const nextZoom = Number(event.target.value) as (typeof ZOOM_OPTIONS)[number];
              setZoom(ZOOM_OPTIONS.includes(nextZoom) ? nextZoom : 100);
            }}
          >
            {ZOOM_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}%
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="spreadsheet-viewer-tool-btn" onClick={() => addRows(1)}>
          + Row
        </button>
        <button
          type="button"
          className="spreadsheet-viewer-tool-btn"
          onClick={() => addColumns(1)}
          disabled={(activeSheet?.columnCount || 0) >= MAX_EDITABLE_COLUMNS}
        >
          + Col
        </button>
        <button
          type="button"
          className="spreadsheet-viewer-tool-btn"
          onClick={() => void copySelectionToClipboard()}
          disabled={!normalizedSelectedRange}
          title="Copy selected cells"
        >
          <Copy size={14} />
          Copy
        </button>
        <button
          type="button"
          className="spreadsheet-viewer-save-btn"
          onClick={handleSave}
          disabled={!dirty || saving || !editablePreview}
          title="Save workbook"
        >
          <Save size={15} />
          {saving ? "Saving" : "Save"}
        </button>
        {saveMessage && <div className="spreadsheet-viewer-save-message">{saveMessage}</div>}
      </div>

      <div className="spreadsheet-viewer-formula">
        <span className="spreadsheet-viewer-cell-address">{selected?.address || selectedAddress}</span>
        <span className="spreadsheet-viewer-fx">{"{ƒ}"}</span>
        <input
          className="spreadsheet-viewer-formula-input"
          value={formulaText}
          placeholder={getWorkbookTitle(fileName)}
          onChange={(event) => {
            const position = selectedCell || { row: 1, column: 1 };
            updateCellValue(position.row, position.column, event.target.value);
          }}
        />
      </div>

      <div
        ref={gridRef}
        className="spreadsheet-viewer-grid-wrap"
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onPaste={(event) => {
          if (editingCell) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          pasteTabularData(text);
        }}
        onCopy={(event) => {
          const text = getSelectedRangeText();
          if (!text) return;
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
          setSaveMessage("Copied");
        }}
      >
        {loading ? (
          <div className="spreadsheet-viewer-state">Loading spreadsheet...</div>
        ) : error ? (
          <div className="spreadsheet-viewer-state spreadsheet-viewer-error">{error}</div>
        ) : !activeSheet ? (
          <div className="spreadsheet-viewer-state">No sheet data available.</div>
        ) : (
          <table
            className="spreadsheet-viewer-grid"
            style={{ "--spreadsheet-zoom": zoomScale } as CSSProperties}
          >
            <thead>
              <tr>
                <th
                  className="spreadsheet-viewer-corner"
                  onClick={selectAllVisibleSheet}
                  title="Select all cells"
                />
                {Array.from({ length: visibleColumnCount }, (_, columnIndex) => (
                  <th
                    key={columnIndex}
                    className={
                      normalizedSelectedRange?.start.column === columnIndex + 1 &&
                      normalizedSelectedRange?.end.column === columnIndex + 1 &&
                      normalizedSelectedRange?.start.row === 1 &&
                      normalizedSelectedRange?.end.row >= Math.max(activeSheet.rowCount || visibleRowCount, 1)
                        ? "spreadsheet-viewer-col-header selected"
                        : "spreadsheet-viewer-col-header"
                    }
                    style={{
                      minWidth: `${Math.max(64, (activeSheet.columnWidths[columnIndex] || 10) * 8) * zoomScale}px`,
                    }}
                    onClick={() => selectColumn(columnIndex + 1)}
                    title={`Select column ${spreadsheetColumnLetter(columnIndex)}`}
                  >
                    {spreadsheetColumnLetter(columnIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: visibleRowCount }, (_, rowIndex) => {
                const row = activeSheet.rows[rowIndex] || [];
                return (
                  <tr key={rowIndex}>
                    <th
                      className={
                        normalizedSelectedRange?.start.row === rowIndex + 1 &&
                        normalizedSelectedRange?.end.row === rowIndex + 1 &&
                        normalizedSelectedRange?.start.column === 1 &&
                        normalizedSelectedRange?.end.column >=
                          Math.max(activeSheet.columnCount || visibleColumnCount, 1)
                          ? "spreadsheet-viewer-row-header selected"
                          : "spreadsheet-viewer-row-header"
                      }
                      onClick={() => selectRow(rowIndex + 1)}
                      title={`Select row ${rowIndex + 1}`}
                    >
                      {rowIndex + 1}
                    </th>
                    {Array.from({ length: visibleColumnCount }, (_, columnIndex) => {
                      const cell = row[columnIndex];
                      const selectedCellActive =
                        selectedCell?.row === rowIndex + 1 && selectedCell?.column === columnIndex + 1;
                      const rangeSelected = cellIsInRange(
                        normalizedSelectedRange,
                        rowIndex + 1,
                        columnIndex + 1,
                      );
                      return (
                        <td
                          key={columnIndex}
                          className={[
                            rangeSelected ? "range-selected" : "",
                            selectedCellActive ? "selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined}
                          style={cell ? getCellStyle(cell) : undefined}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectCell(
                              { row: rowIndex + 1, column: columnIndex + 1 },
                              event.shiftKey,
                            );
                          }}
                          onMouseEnter={(event) => {
                            if (event.buttons !== 1 || !selectedRange?.start) return;
                            setSelectedCell({ row: rowIndex + 1, column: columnIndex + 1 });
                            setSelectedRange({
                              start: selectedRange.start,
                              end: { row: rowIndex + 1, column: columnIndex + 1 },
                            });
                          }}
                          onDoubleClick={() =>
                            startEditing({ row: rowIndex + 1, column: columnIndex + 1 })
                          }
                          title={cell?.formula ? `=${cell.formula}` : cell?.value}
                        >
                          {editingCell?.row === rowIndex + 1 &&
                          editingCell?.column === columnIndex + 1 ? (
                            <input
                              className="spreadsheet-viewer-cell-input"
                              value={editingValue}
                              autoFocus
                              onChange={(event) => setEditingValue(event.target.value)}
                              onBlur={commitEditing}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === "Tab") {
                                  event.preventDefault();
                                  commitEditing();
                                  if (event.key === "Tab") moveSelection(0, event.shiftKey ? -1 : 1);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelEditing();
                                }
                              }}
                            />
                          ) : (
                            getCellDisplayText(cell)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editablePreview && editablePreview.sheets.length > 1 && (
        <div className="spreadsheet-viewer-sheets">
          {editablePreview.sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              className={index === activeSheetIndex ? "active" : undefined}
              onClick={() => {
                setActiveSheetIndex(index);
                setSelectedCell({ row: 1, column: 1 });
              }}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
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
                  <SpreadsheetArtifactCard
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
                        <span className="attachment-icon" aria-hidden="true">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                        </span>
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
                    title={
                      voiceInput.state === "idle"
                        ? "Start voice input"
                        : voiceInput.state === "recording"
                          ? "Stop recording"
                          : "Processing..."
                    }
                    onClick={() => void voiceInput.toggleRecording()}
                    disabled={voiceInput.state === "processing" || fullscreenSending}
                  >
                    {voiceInput.state === "processing" ? (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="voice-processing-spin"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                      </svg>
                    ) : voiceInput.state === "recording" ? (
                      <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    ) : (
                      <Mic size={16} aria-hidden="true" />
                    )}
                    {voiceInput.state === "recording" && (
                      <span
                        className="voice-recording-indicator"
                        style={{ width: `${voiceInput.audioLevel}%` }}
                      />
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
              <span className="input-status-workspace">
                Work in a folder
              </span>
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
