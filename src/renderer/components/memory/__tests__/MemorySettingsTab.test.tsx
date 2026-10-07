import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryFeaturesSettings, Workspace } from "../../../../shared/types";
import {
  compressionCostNotice,
  isMemoryInUse,
  isSessionRecoveryOn,
  memoryInUsePatch,
  parseAwarenessTtlMinutes,
  parseCompressionBudget,
  parseStorageCapMb,
  scopeCaption,
  sessionRecoveryPatch,
  strictPrivacyPatch,
  type WorkspaceMemorySettings,
} from "../memory-settings-model";
import { MemoryImportButtons, type MemoryImportButtonsProps } from "../MemoryImportSection";
import {
  ChronicleConnectionRow,
  MemorySettingsTab,
  WorkspaceMemorySection,
  type WorkspaceMemorySectionProps,
} from "../MemorySettingsTab";
import {
  ChronicleObservationsView,
  ImportedMemoriesView,
  parseImportTag,
  type ImportedMemoriesViewProps,
} from "../MemorySourcesLists";
import { MemorySourcesTab } from "../MemorySourcesTab";

const WORKSPACE = {
  id: "ws-1",
  name: "Acme",
  path: "/Users/sam/acme",
  permissions: { read: true, write: true, delete: true },
} as unknown as Workspace;

const FEATURES: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
  memoryRepoEnabled: true,
  memoryCompressionDailyTokenBudget: 20000,
};

const SETTINGS: WorkspaceMemorySettings = {
  workspaceId: "ws-1",
  enabled: true,
  autoCapture: true,
  compressionEnabled: true,
  retentionDays: 90,
  maxStorageMb: 100,
  privacyMode: "normal",
};

/**
 * The first element in a tree that matches, expanding function components by calling them
 * (only for components without hooks: the Settings tab's pure rows and sections).
 */
function findElement(
  node: ReactNode,
  match: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  const props = node.props as Record<string, unknown>;
  if (typeof node.type === "function") {
    const found = findElement((node.type as (p: unknown) => ReactNode)(props), match);
    if (found) return found;
  }
  for (const value of Object.values(props)) {
    if (Array.isArray(value) || isValidElement(value)) {
      const found = findElement(value as ReactNode, match);
      if (found) return found;
    }
  }
  return null;
}

function switchNamed(tree: ReactNode, label: string) {
  const input = findElement(
    tree,
    (element) =>
      element.type === "input" &&
      (element.props as { "aria-label"?: string })["aria-label"] === label,
  );
  if (!input) throw new Error(`No switch named ${label}`);
  return input.props as {
    checked: boolean;
    disabled?: boolean;
    onChange: (event: { target: { checked: boolean } }) => void;
  };
}

function workspaceSection(overrides: Partial<WorkspaceMemorySectionProps> = {}) {
  const props: WorkspaceMemorySectionProps = {
    settings: SETTINGS,
    loadError: null,
    saving: false,
    clearing: false,
    clearSummary: null,
    canDelete: true,
    onSave: vi.fn(),
    onClear: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  return { props, tree: WorkspaceMemorySection(props) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Memory Settings tab layout", () => {
  const html = () =>
    renderToStaticMarkup(
      <MemorySettingsTab
        workspace={WORKSPACE}
        features={FEATURES}
        featuresSaving={false}
        onSaveFeatures={vi.fn(async () => undefined)}
        onFeaturesSaved={vi.fn()}
        canDelete
        onOpenSettingsTab={vi.fn()}
      />,
    );

  it("shows the sections in order, each with its scope", () => {
    const markup = html();
    const order = [...markup.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["workspace", "memory-folder", "import", "connections", "proactive"]);
    const headings = [
      ...markup.matchAll(/<h3[^>]*>([^<]+)<\/h3><span class="memory-settings-scope">([^<]+)</g),
    ].map((match) => [match[1], match[2]]);
    expect(headings).toEqual([
      ["This workspace", "this workspace: Acme"],
      ["Memory folder", "all workspaces"],
      ["Import", "this workspace: Acme"],
      ["Connections", "all workspaces"],
      ["Proactive", "all workspaces"],
    ]);
    expect(markup.indexOf('data-section="proactive"')).toBeLessThan(
      markup.indexOf("memory-settings-advanced"),
    );
  });

  it("keeps Advanced collapsed (and unrendered) by default", () => {
    const markup = html();
    expect(markup).toMatch(
      /<details class="memory-settings-advanced"><summary>Advanced <span[^>]*>[^<]*<\/span><\/summary><\/details>/,
    );
    expect(markup).not.toContain("memory-settings-advanced-body");
    expect(markup).not.toContain("Session recovery");
  });

  it("drops the retired controls and texts", () => {
    const markup = html();
    for (const gone of [
      "Pending Memory Writes",
      "Enable Memory Inspector",
      "User Memory Facts",
      "Research Preview",
      "Global Toggles",
      "Per Workspace",
      "Maintenance Heartbeats",
      "Disabled - No memory capture",
    ]) {
      expect(markup).not.toContain(gone);
    }
  });

  it("names the scope of a section", () => {
    expect(scopeCaption({ kind: "workspace", name: "Acme" })).toBe("this workspace: Acme");
    expect(scopeCaption({ kind: "all" })).toBe("all workspaces");
  });
});

describe("This workspace", () => {
  it("shows the retired privacy mode Disabled as Use memory off, and turning it on leaves it", () => {
    const { props, tree } = workspaceSection({
      settings: { ...SETTINGS, privacyMode: "disabled" },
    });
    const use = switchNamed(tree, "Use memory");
    expect(use.checked).toBe(false);
    // The switches that need memory are off limits while it is off.
    expect(switchNamed(tree, "Learn from chats").disabled).toBe(true);
    expect(switchNamed(tree, "Strict privacy").disabled).toBe(true);
    use.onChange({ target: { checked: true } });
    expect(props.onSave).toHaveBeenCalledWith({ enabled: true, privacyMode: "normal" });
    expect(renderToStaticMarkup(<>{tree}</>)).not.toMatch(/>Disabled</);
  });

  it("turns memory on and off without touching privacy otherwise", () => {
    expect(isMemoryInUse(SETTINGS)).toBe(true);
    expect(isMemoryInUse({ enabled: false, privacyMode: "normal" })).toBe(false);
    expect(isMemoryInUse({ enabled: true, privacyMode: "disabled" })).toBe(false);
    expect(memoryInUsePatch(true, "strict")).toEqual({ enabled: true });
    expect(memoryInUsePatch(false, "disabled")).toEqual({ enabled: false });
    const { props, tree } = workspaceSection();
    switchNamed(tree, "Use memory").onChange({ target: { checked: false } });
    expect(props.onSave).toHaveBeenCalledWith({ enabled: false });
  });

  it("maps Strict privacy to the strict and normal privacy modes", () => {
    expect(strictPrivacyPatch(true)).toEqual({ privacyMode: "strict" });
    expect(strictPrivacyPatch(false)).toEqual({ privacyMode: "normal" });
    const strict = workspaceSection({ settings: { ...SETTINGS, privacyMode: "strict" } });
    const toggle = switchNamed(strict.tree, "Strict privacy");
    expect(toggle.checked).toBe(true);
    toggle.onChange({ target: { checked: false } });
    expect(strict.props.onSave).toHaveBeenCalledWith({ privacyMode: "normal" });
    const normal = workspaceSection();
    expect(switchNamed(normal.tree, "Strict privacy").checked).toBe(false);
    switchNamed(normal.tree, "Strict privacy").onChange({ target: { checked: true } });
    expect(normal.props.onSave).toHaveBeenCalledWith({ privacyMode: "strict" });
  });

  it("offers history, learning and clearing in one place", () => {
    const { props, tree } = workspaceSection();
    const markup = renderToStaticMarkup(<>{tree}</>);
    expect(markup).toContain("Keep history for");
    expect(markup).toMatch(/<option value="90" selected="">90 days<\/option>/);
    expect(markup).toMatch(/settings-button-danger[^>]*>Clear memory</);
    switchNamed(tree, "Learn from chats").onChange({ target: { checked: false } });
    expect(props.onSave).toHaveBeenCalledWith({ autoCapture: false });
    const noDelete = renderToStaticMarkup(<>{workspaceSection({ canDelete: false }).tree}</>);
    expect(noDelete).toMatch(/disabled=""[^>]*>Clear memory</);
  });
});

describe("Advanced rules", () => {
  it("switches session recovery with both stored fields and nothing else", () => {
    expect(sessionRecoveryPatch(true)).toEqual({
      durableContextEnabled: true,
      durableContextMode: "on",
    });
    expect(sessionRecoveryPatch(false)).toEqual({
      durableContextEnabled: false,
      durableContextMode: "off",
    });
    expect(isSessionRecoveryOn({ durableContextMode: "experimental" })).toBe(true);
    expect(isSessionRecoveryOn({ durableContextEnabled: false, durableContextMode: "off" })).toBe(
      false,
    );
  });

  it("reads typed numbers into their ranges", () => {
    expect(parseStorageCapMb("3")).toBe(10);
    expect(parseStorageCapMb("9000")).toBe(5000);
    expect(parseStorageCapMb("")).toBeNull();
    expect(parseCompressionBudget("50")).toBe(1000);
    expect(parseCompressionBudget("abc")).toBeNull();
    expect(parseAwarenessTtlMinutes("2")).toBe(5);
    expect(parseAwarenessTtlMinutes("5000")).toBe(1440);
  });

  it("names the provider cost and the daily budget of AI compression", () => {
    expect(compressionCostNotice(20000)).toBe(
      "AI memory compression uses your model provider and costs tokens (up to 20,000 tokens/day across all workspaces). Private memories are never sent. Turn it off to keep only local summaries.",
    );
    expect(compressionCostNotice(null)).toContain("up to 20,000 tokens/day");
    expect(compressionCostNotice(50000)).toContain("up to 50,000 tokens/day");
  });
});

describe("Connections", () => {
  it("links Chronicle to the Tools settings", () => {
    const onOpenSettingsTab = vi.fn();
    const tree = ChronicleConnectionRow({ onOpenSettingsTab });
    expect(renderToStaticMarkup(<>{tree}</>)).toContain("Screen context · managed in Tools");
    const open = findElement(tree, (element) => element.type === "button");
    if (!open) throw new Error("No Open button");
    (open.props as { onClick: () => void }).onClick();
    expect(onOpenSettingsTab).toHaveBeenCalledWith("tools");
    expect(renderToStaticMarkup(<ChronicleConnectionRow />)).not.toContain("<button");
  });
});

describe("Import row", () => {
  const buttons = (overrides: Partial<MemoryImportButtonsProps> = {}) =>
    renderToStaticMarkup(
      <MemoryImportButtons
        memoryInUse
        canImportChatGPT
        canImportFolder
        folderReady
        folderBusy={false}
        importingFolder={false}
        chatGPTOpen={false}
        onFromAssistant={vi.fn()}
        onChatGPT={vi.fn()}
        onFolder={vi.fn()}
        {...overrides}
      />,
    );

  it("offers three secondary buttons in one row", () => {
    const markup = buttons();
    const labels = [
      ...markup.matchAll(/<button[^>]*class="settings-button"[^>]*>([^<]+)<\/button>/g),
    ].map((match) => match[1]);
    expect(labels).toEqual(["From another assistant", "ChatGPT export", "Folder of notes"]);
    expect(markup).not.toContain("disabled");
  });

  it("disables what cannot run here", () => {
    expect(buttons({ canImportFolder: false })).not.toContain("Folder of notes");
    expect(buttons({ canImportChatGPT: false })).toMatch(/disabled=""[^>]*>ChatGPT export/);
    const off = buttons({ memoryInUse: false });
    expect(off).toMatch(/disabled=""[^>]*>From another assistant/);
    expect(off).toMatch(/disabled=""[^>]*>ChatGPT export/);
    expect(buttons({ folderReady: false })).toMatch(/disabled=""[^>]*>Folder of notes/);
    expect(buttons({ folderBusy: true, importingFolder: true })).toContain(
      ">Importing...</button>",
    );
  });
});

describe("Sources tab lists", () => {
  it("renders imported memories and Chronicle observations under the sources report", () => {
    const markup = renderToStaticMarkup(
      <MemorySourcesTab workspaceId="ws-1" api={vi.fn() as never} />,
    );
    expect(markup).toContain('data-group="imported-memories"');
    expect(markup).toContain('data-group="chronicle-observations"');
    expect(markup.indexOf("Imported memories")).toBeLessThan(
      markup.indexOf("Chronicle observations"),
    );
  });

  it("hides a list where the browser host lacks its methods", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: { listChronicleObservations: true } },
    });
    const markup = renderToStaticMarkup(
      <MemorySourcesTab workspaceId="ws-1" api={vi.fn() as never} />,
    );
    expect(markup).not.toContain('data-group="imported-memories"');
    expect(markup).toContain('data-group="chronicle-observations"');
  });

  const imported = (overrides: Partial<ImportedMemoriesViewProps> = {}) =>
    renderToStaticMarkup(
      <ImportedMemoriesView
        stats={{ count: 2, totalTokens: 900 }}
        expanded
        items={[
          {
            id: "m1",
            content: '[Imported from ChatGPT - "Trip plans"]\nBook the train',
            tokens: 400,
            createdAt: 1,
          },
          {
            id: "m2",
            content: "[cowork:prompt_recall=ignore]\n[Imported from Gemini]\nPrefers tea",
            tokens: 500,
            createdAt: 1,
          },
        ]}
        hasMore
        loading={false}
        canDelete
        busyId={null}
        updatingId={null}
        deletingAll={false}
        onToggleExpanded={vi.fn()}
        onToggleIgnored={vi.fn()}
        onDelete={vi.fn()}
        onLoadMore={vi.fn()}
        onDeleteAll={vi.fn()}
        {...overrides}
      />,
    );

  it("keeps the imported memory actions", () => {
    const markup = imported();
    expect(markup).toContain("ChatGPT: Trip plans");
    expect(markup).toContain(">Ignore in prompts</button>");
    expect(markup).toContain(">Use in prompts</button>");
    expect(markup).toContain("ignored in prompts");
    expect(markup).toContain(">Load more</button>");
    expect(markup).toMatch(/settings-button-danger[^>]*>Delete all imported memories/);
    expect(imported({ canDelete: false })).toMatch(/disabled=""[^>]*>Delete all imported memories/);
    expect(imported({ expanded: false })).not.toContain("Ignore in prompts");
    expect(parseImportTag("[Imported from Gemini]\nLikes maps")).toMatchObject({
      title: "Imported from Gemini",
      isImported: true,
      ignoredForPromptRecall: false,
    });
  });

  it("keeps the Chronicle observation actions", () => {
    const markup = renderToStaticMarkup(
      <ChronicleObservationsView
        items={[
          {
            id: "o1",
            appName: "Safari",
            windowTitle: "Release notes",
            localTextSnippet: "Ship Friday",
            capturedAt: 1,
            memoryId: "m1",
          },
        ]}
        loaded
        canDelete
        clearing={false}
        deletingId={null}
        onClear={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(markup).toContain("Release notes");
    expect(markup).toContain("Safari • Ship Friday");
    expect(markup).toContain("memory linked");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain(">Clear all</button>");
  });
});
