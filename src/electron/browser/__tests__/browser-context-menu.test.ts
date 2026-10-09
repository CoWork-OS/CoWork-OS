import { describe, expect, it, vi } from "vitest";
import {
  type BrowserContextMenuDeps,
  buildBrowserContextMenuTemplate,
} from "../browser-context-menu";

function deps(overrides: Partial<BrowserContextMenuDeps> = {}) {
  const base = {
    owner: { taskId: "t", sessionId: "default", tabId: "a", kind: "tab" as const },
    contents: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: vi.fn(),
      reload: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      copyImageAt: vi.fn(),
      replaceMisspelling: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() },
    },
    writeText: vi.fn(),
    openTab: vi.fn(),
    openExternal: vi.fn(),
    sendAction: vi.fn(),
  };
  return { ...base, ...overrides };
}

const labels = (template: Array<{ label?: string; type?: string }>) =>
  template.map((item) => item.label || item.type);

const click = (template: Array<Any>, label: string) =>
  template.find((item) => item.label === label)?.click?.();

describe("browser page context menu", () => {
  it("offers navigation and workbench actions on the page background", () => {
    const d = deps();
    const template = buildBrowserContextMenuTemplate({ x: 5, y: 6 }, d);
    expect(labels(template)).toEqual([
      "Back",
      "Forward",
      "Reload",
      "separator",
      "Annotate This Element",
      "Take Screenshot",
    ]);
    expect(template.find((item) => item.label === "Forward")?.enabled).toBe(false);
    click(template, "Back");
    expect(d.contents.goBack).toHaveBeenCalled();
    click(template, "Annotate This Element");
    expect(d.sendAction).toHaveBeenCalledWith({ kind: "annotate", x: 5, y: 6 });
  });

  it("opens http(s) links as tabs and ignores other schemes", () => {
    const d = deps();
    const template = buildBrowserContextMenuTemplate(
      { x: 0, y: 0, linkURL: "https://example.com/doc" },
      d,
    );
    click(template, "Open Link in Background Tab");
    expect(d.openTab).toHaveBeenCalledWith("https://example.com/doc", true);
    click(template, "Copy Link Address");
    expect(d.writeText).toHaveBeenCalledWith("https://example.com/doc");

    const jsLink = buildBrowserContextMenuTemplate(
      { x: 0, y: 0, linkURL: "javascript:alert(1)" },
      deps(),
    );
    expect(labels(jsLink)).not.toContain("Open Link in New Tab");
  });

  it("offers spelling, editing, search and ask for a selection in a field", () => {
    const d = deps();
    const template = buildBrowserContextMenuTemplate(
      {
        x: 0,
        y: 0,
        isEditable: true,
        selectionText: "teh",
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "ten"],
        editFlags: { canPaste: false },
        pageURL: "https://example.com/",
      },
      d,
    );
    expect(labels(template).slice(0, 3)).toEqual(["the", "ten", "Add to Dictionary"]);
    expect(template.find((item) => item.label === "Paste")?.enabled).toBe(false);
    click(template, "the");
    expect(d.contents.replaceMisspelling).toHaveBeenCalledWith("the");
    click(template, 'Search the web for "teh"');
    expect(d.sendAction).toHaveBeenCalledWith({ kind: "search", text: "teh" });
    click(template, "Ask CoWork About This");
    expect(d.sendAction).toHaveBeenCalledWith({
      kind: "ask",
      text: "teh",
      url: "https://example.com/",
    });
  });

  it("leaves workbench-only actions out of popup windows", () => {
    const template = buildBrowserContextMenuTemplate(
      { x: 0, y: 0 },
      deps({ owner: { taskId: "t", sessionId: "default", tabId: "p", kind: "popup" } }),
    );
    expect(labels(template)).not.toContain("Annotate This Element");
  });
});
