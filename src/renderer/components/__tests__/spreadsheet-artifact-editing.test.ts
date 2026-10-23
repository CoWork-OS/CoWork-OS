import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpreadsheetPreview } from "../../../shared/spreadsheet-preview";
import { SpreadsheetArtifactViewer } from "../SpreadsheetArtifactViewer";

// Follow the PDF surface lifecycle tests: run the viewer's real event handlers
// and effects with persistent hook state, without a native Electron window.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  let effects: Array<() => void> = [];
  const changed = (before: unknown[] | undefined, after: unknown[]) =>
    !before ||
    after.length !== before.length ||
    after.some((value, i) => !Object.is(value, before[i]));
  const useMemo = (create: () => unknown, deps: unknown[]) => {
    const slot = (slots[cursor++] ??= {});
    if (changed(slot.deps, deps)) {
      slot.value = create();
      slot.deps = deps;
    }
    return slot.value;
  };
  return {
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    begin() {
      cursor = 0;
    },
    commit() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    dispose() {
      slots.forEach((slot) => slot.cleanup?.());
    },
    useRef(value: unknown) {
      return (slots[cursor++] ??= { value: { current: value } }).value;
    },
    useState(value: unknown) {
      const slot = (slots[cursor++] ??= { value });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useMemo,
    useCallback(callback: unknown, deps: unknown[]) {
      return useMemo(() => callback, deps);
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: hooks.useRef,
  useState: hooks.useState,
  useMemo: hooks.useMemo,
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
}));
vi.mock("../../hooks/useVoiceInput", () => ({ useVoiceInput: () => ({ state: "idle" }) }));
vi.mock("../MainContent", () => ({ ModelDropdown: () => null }));

type Element = ReactElement<Record<string, Any>>;
const elements = (tree: unknown): Element[] => {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
};
const preview: SpreadsheetPreview = {
  activeSheetName: "Costs",
  sheetCount: 2,
  sheets: [
    {
      name: "Costs",
      rowCount: 1,
      columnCount: 2,
      columnWidths: [12, 12],
      rows: [
        [
          { address: "A1", row: 1, column: 1, value: "Original" },
          { address: "B1", row: 1, column: 2, value: "Neighbor" },
        ],
      ],
    },
    {
      name: "Summary",
      rowCount: 1,
      columnCount: 1,
      columnWidths: [12],
      rows: [[{ address: "A1", row: 1, column: 1, value: "Independent" }]],
    },
  ],
};
const fileData = {
  path: "/workspace/costs.xlsx",
  fileName: "costs.xlsx",
  fileType: "xlsx",
  content: null,
  size: 50,
  spreadsheetPreview: preview,
};
const updateSpreadsheetFile = vi.fn();
const onClose = vi.fn();
const confirmDiscard = vi.fn();
let gridFocus: ReturnType<typeof vi.fn>;

function render() {
  hooks.begin();
  const nodes = elements(
    SpreadsheetArtifactViewer({
      filePath: fileData.path,
      workspacePath: "/workspace",
      mode: "sidebar",
      onClose,
      onFullscreen: () => {},
      onExitFullscreen: () => {},
    }),
  );
  const grid = nodes.find((node) => node.props.className === "spreadsheet-viewer-grid-wrap");
  if (grid) grid.props.ref.current = { focus: gridFocus };
  hooks.commit();
  return nodes;
}

async function loadViewer() {
  render();
  // Drain the viewer's async open -> legacy read -> finally loading lifecycle.
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  render();
  return render();
}

const cell = (nodes: Element[], index = 0) => nodes.filter((node) => node.type === "td")[index];
const editor = (nodes: Element[]) => {
  const input = nodes.find((node) => node.props.className === "spreadsheet-viewer-cell-input");
  if (!input) throw new Error("Expected an active cell editor");
  return input;
};
const save = (nodes: Element[]) => nodes.find((node) => node.props.title === "Save workbook")!;
const mouseDown = () => ({ preventDefault: vi.fn(), shiftKey: false });

beforeEach(() => {
  hooks.reset();
  gridFocus = vi.fn();
  onClose.mockReset();
  confirmDiscard.mockReset().mockReturnValue(false);
  updateSpreadsheetFile.mockReset().mockResolvedValue({ success: true, data: fileData });
  vi.stubGlobal("window", {
    confirm: confirmDiscard,
    electronAPI: {
      readFileForViewer: vi.fn().mockResolvedValue({ success: true, data: fileData }),
      updateSpreadsheetFile,
    },
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  hooks.dispose();
  vi.unstubAllGlobals();
});

describe("spreadsheet cell editing", () => {
  it("focuses the grid after a cell click so keyboard navigation reaches the selection", async () => {
    const nodes = await loadViewer();
    cell(nodes).props.onMouseDown(mouseDown());
    expect(gridFocus).toHaveBeenCalledOnce();
    const selected = render();
    selected
      .find((node) => node.props.className === "spreadsheet-viewer-grid-wrap")!
      .props.onKeyDown({ key: "ArrowRight", shiftKey: false, preventDefault: vi.fn() });
    expect(cell(render(), 1).props.className).toContain("selected");
    expect(save(render()).props.disabled).toBe(true);
  });

  it("closes a clean workbook without prompting", async () => {
    const nodes = await loadViewer();
    nodes.find((node) => node.props.title === "Close spreadsheet")!.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("keeps a pending cell draft when closing is cancelled, even before a render", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const nodes = render();
    editor(nodes).props.onChange({ target: { value: "Keep this pending edit" } });
    nodes.find((node) => node.props.title === "Close spreadsheet")!.props.onClick();
    expect(confirmDiscard).toHaveBeenCalledWith(expect.stringContaining("costs.xlsx"));
    expect(onClose).not.toHaveBeenCalled();
    expect(editor(render()).props.value).toBe("Keep this pending edit");
  });

  it("requires explicit discard for committed unsaved changes", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const input = editor(render());
    input.props.onChange({ target: { value: "Unsaved edit" } });
    input.props.onBlur();
    const nodes = render();
    const close = nodes.find((node) => node.props.title === "Close spreadsheet")!;
    close.props.onClick();
    expect(onClose).not.toHaveBeenCalled();
    expect(cell(render()).props.children).toBe("Unsaved edit");
    confirmDiscard.mockReturnValue(true);
    close.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(updateSpreadsheetFile).not.toHaveBeenCalled();
  });

  it("commits the latest typed value before another cell's mouse-down removes the editor", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const nodes = render();
    const input = editor(nodes);
    input.props.onChange({ target: { value: "Revised supplier" } });
    // Mouse-down prevents the browser's normal blur, and both events can run
    // before a render. The selection handler must commit the current draft.
    cell(nodes, 1).props.onMouseDown(mouseDown());
    input.props.onBlur();

    const selected = render();
    expect(cell(selected).props.children).toBe("Revised supplier");
    expect(cell(selected, 1).props.className).toContain("selected");
    await save(selected).props.onClick();
    expect(updateSpreadsheetFile.mock.calls[0][0].preview.sheets[0].rows[0][0].value).toBe(
      "Revised supplier",
    );
  });

  it("keeps native caret and word selection inside the active editor", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    editor(render()).props.onChange({ target: { value: "Unsaved draft" } });
    for (const eventName of ["onMouseDown", "onDoubleClick"]) {
      const nodes = render();
      let stopped = false;
      const event = {
        ...mouseDown(),
        stopPropagation: () => {
          stopped = true;
        },
      };
      editor(nodes).props[eventName]?.(event);
      if (!stopped) cell(nodes).props[eventName](event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(editor(render()).props.value).toBe("Unsaved draft");
    }
  });

  it("commits pending cell text before selecting a whole column", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const nodes = render();
    editor(nodes).props.onChange({ target: { value: "Column selection draft" } });
    const header = nodes.find(
      (node) => node.type === "th" && node.props.title === "Select column B",
    );
    expect(header).toBeDefined();
    header!.props.onClick();
    expect(cell(render()).props.children).toBe("Column selection draft");
  });

  it("discards an Escape draft even when returning grid focus immediately fires blur", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const input = editor(render());
    input.props.onChange({ target: { value: "Discard this" } });
    gridFocus.mockImplementation(() => input.props.onBlur());
    input.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });

    const nodes = render();
    expect(cell(nodes).props.children).toBe("Original");
    expect(save(nodes).props.disabled).toBe(true);
  });

  it("commits a draft to its original sheet before changing the active sheet", async () => {
    cell(await loadViewer()).props.onDoubleClick();
    const nodes = render();
    editor(nodes).props.onChange({ target: { value: "Saved on Costs" } });
    nodes
      .find((node) => node.type === "button" && node.props.children === "Summary")!
      .props.onClick();

    const switched = render();
    expect(cell(switched).props.children).toBe("Independent");
    expect(switched.some((node) => node.props.className === "spreadsheet-viewer-cell-input")).toBe(
      false,
    );
    await save(switched).props.onClick();
    const saved = updateSpreadsheetFile.mock.calls[0][0].preview;
    expect(saved.sheets[0].rows[0][0].value).toBe("Saved on Costs");
    expect(saved.sheets[1].rows[0][0].value).toBe("Independent");
  });

  it("queues one cell patch when selection and the old input's blur both commit", async () => {
    const session = {
      sessionId: "workbook-session",
      filePath: fileData.path,
      fileName: fileData.fileName,
      format: "xlsx",
      sheets: preview.sheets.map((sheet) => ({ ...sheet, id: sheet.name })),
      activeSheetId: "Costs",
      capabilities: { canEditCells: true, canEditStructure: true },
    };
    const applySpreadsheetPatches = vi.fn().mockResolvedValue({ success: true, session });
    Object.assign(window.electronAPI, {
      openSpreadsheetWorkbook: vi.fn().mockResolvedValue({ success: true, session, preview }),
      applySpreadsheetPatches,
      saveSpreadsheetWorkbook: vi.fn().mockResolvedValue({ success: true, session, preview }),
      closeSpreadsheetWorkbook: vi.fn(),
    });
    cell(await loadViewer()).props.onDoubleClick();
    const nodes = render();
    const input = editor(nodes);
    input.props.onChange({ target: { value: "Committed once" } });
    cell(nodes, 1).props.onMouseDown(mouseDown());
    input.props.onBlur();
    await save(render()).props.onClick();

    expect(applySpreadsheetPatches).toHaveBeenCalledExactlyOnceWith({
      sessionId: "workbook-session",
      patches: [
        {
          type: "setCell",
          sheetId: "Costs",
          row: 1,
          column: 1,
          input: { value: "Committed once" },
        },
      ],
    });
    expect(updateSpreadsheetFile).not.toHaveBeenCalled();
  });

  it.each(["Enter", "Tab"])(
    "keeps %s commit behavior when grid focus also blurs the input",
    async (key) => {
      cell(await loadViewer()).props.onDoubleClick();
      const input = editor(render());
      input.props.onChange({ target: { value: "=2+3" } });
      gridFocus.mockImplementation(() => input.props.onBlur());
      input.props.onKeyDown({ key, preventDefault: vi.fn(), shiftKey: false });

      const nodes = render();
      expect(cell(nodes).props.children).toBe("=2+3");
      if (key === "Tab") expect(cell(nodes, 1).props.className).toContain("selected");
      await save(nodes).props.onClick();
      expect(updateSpreadsheetFile.mock.calls[0][0].preview.sheets[0].rows[0][0].formula).toBe(
        "2+3",
      );
    },
  );
});
