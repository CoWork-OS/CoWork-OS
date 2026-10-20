import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserSettings,
} from "../../../../shared/browser-settings";
import { useBrowserSettings } from "../../../hooks/useBrowserSettings";
import { ToolbarMenu } from "../ToolbarMenu";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  mounting: false,
  effects: [] as Array<() => void | (() => void)>,
}));

// Follow the adjacent profile-menu tests: exercise real elements and handlers
// in Node, simulating only React's hook storage and mount/unmount effects.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    if (hooks.mounting) hooks.effects.push(effect);
  },
}));

type RowProps = {
  children?: ReactNode;
  className?: string;
  role?: string;
  "aria-label"?: string;
  "aria-checked"?: boolean;
  "aria-expanded"?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};
type Row = ReactElement<RowProps>;

function rows(node: ReactNode): Row[] {
  if (Array.isArray(node)) return node.flatMap(rows);
  if (!isValidElement<RowProps>(node)) return [];
  return [node, ...rows(node.props.children)];
}

function find(tree: ReactNode, match: (row: Row) => boolean): Row {
  const row = rows(tree).find(match);
  if (!row) throw new Error("Expected toolbar menu control was not found");
  return row;
}

function option(tree: ReactNode, label: string): Row {
  return find(
    tree,
    (row) =>
      row.type === "button" &&
      rows(row.props.children).some(
        (child) => child.type === "span" && child.props.children === label,
      ),
  );
}

function click(row: Row): void {
  if (row.props.disabled || !row.props.onClick) throw new Error("Control is not clickable");
  row.props.onClick();
}

let stored: BrowserSettings;
const getBrowserSettings = vi.fn();
const saveBrowserSettings = vi.fn();
const saveAppearanceSettings = vi.fn();
let cleanups: Array<() => void>;

function mountToolbar() {
  hooks.values = [];
  hooks.effects = [];
  const render = () => {
    hooks.cursor = 0;
    const browser = useBrowserSettings();
    const tree = ToolbarMenu({
      hasPage: false,
      colorScheme: browser.settings.colorScheme,
      onColorScheme: (colorScheme) => void browser.save({ colorScheme }),
      viewports: [],
      activeViewport: null,
      snapshotOverlay: false,
      diagnosticsOpen: false,
      onAnnotateScreenshot: vi.fn(),
      onScreenshot: vi.fn(),
      onOpenExternal: vi.fn(),
      onViewport: vi.fn(),
      onToggleSnapshotOverlay: vi.fn(),
      onToggleDiagnostics: vi.fn(),
    });
    return { tree, ...browser };
  };
  hooks.mounting = true;
  render();
  hooks.mounting = false;
  const mountedCleanups = hooks.effects
    .map((effect) => effect())
    .filter((cleanup): cleanup is () => void => typeof cleanup === "function");
  cleanups.push(...mountedCleanups);
  const open = () => {
    click(find(render().tree, (row) => row.props["aria-label"] === "More"));
    return render().tree;
  };
  return { render, open, unmount: () => mountedCleanups.forEach((cleanup) => cleanup()) };
}

beforeEach(() => {
  cleanups = [];
  hooks.mounting = false;
  stored = { ...DEFAULT_BROWSER_SETTINGS };
  getBrowserSettings.mockReset().mockImplementation(async () => ({ ...stored }));
  saveBrowserSettings.mockReset().mockImplementation(async (patch: Partial<BrowserSettings>) => {
    stored = { ...stored, ...patch };
    return { success: true, settings: { ...stored } };
  });
  saveAppearanceSettings.mockReset();
  const browserWindow = Object.assign(new EventTarget(), {
    electronAPI: { getBrowserSettings, saveBrowserSettings, saveAppearanceSettings },
  });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        super(type);
        this.detail = init.detail;
      }
    },
  );
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("browser toolbar appearance", () => {
  it("connects the workbench menu to browser settings rather than app appearance settings", () => {
    const source = readFileSync(new URL("../../BrowserWorkbenchView.tsx", import.meta.url), "utf8");
    expect(source).toContain("colorScheme={browserSettings.colorScheme}");
    expect(source).toMatch(
      /onColorScheme=\{\(colorScheme\) => \{\s*void saveBrowserSettings\(\{ colorScheme \}\)/,
    );
    expect(source).not.toMatch(/saveAppearanceSettings|setThemeMode|nativeTheme/);
  });

  it("checks Match app, not Light or Dark, before an explicit preference", async () => {
    const toolbar = mountToolbar();
    await vi.waitFor(() => expect(toolbar.render().loaded).toBe(true));
    const tree = toolbar.open();
    expect(find(tree, (row) => row.props.children === "Appearance")).toBeDefined();
    for (const label of ["Match app", "Light", "Dark"]) {
      const row = option(tree, label);
      const checked = label === "Match app";
      expect(row.props.role).toBe("menuitemcheckbox");
      expect(row.props["aria-checked"]).toBe(checked);
      expect(row.props.disabled).not.toBe(true);
      expect(
        rows(row).filter((child) => child.props.className === "browser-workbench-menu-check"),
      ).toHaveLength(checked ? 1 : 0);
    }
    expect(saveBrowserSettings).not.toHaveBeenCalled();
  });

  it.each(["light", "dark"] as const)(
    "Match app clears a saved %s choice and stays selected after remount",
    async (colorScheme) => {
      stored.colorScheme = colorScheme;
      const toolbar = mountToolbar();
      await vi.waitFor(() => expect(toolbar.render().settings.colorScheme).toBe(colorScheme));
      expect(option(toolbar.open(), "Match app").props["aria-checked"]).toBe(false);
      click(find(toolbar.render().tree, (row) => row.props["aria-label"] === "More"));

      click(option(toolbar.open(), "Match app"));
      expect(saveBrowserSettings).toHaveBeenCalledExactlyOnceWith({ colorScheme: null });
      await vi.waitFor(() => expect(stored.colorScheme).toBeNull());
      await vi.waitFor(() => expect(toolbar.render().settings.colorScheme).toBeNull());

      toolbar.unmount();
      const recreated = mountToolbar();
      await vi.waitFor(() => expect(recreated.render().loaded).toBe(true));
      const tree = recreated.open();
      expect(option(tree, "Match app").props["aria-checked"]).toBe(true);
      expect(option(tree, "Light").props["aria-checked"]).toBe(false);
      expect(option(tree, "Dark").props["aria-checked"]).toBe(false);
      expect(saveAppearanceSettings).not.toHaveBeenCalled();
    },
  );

  it.each(["light", "dark"] as const)(
    "selects %s, persists it, and restores its exclusive checkmark after remount",
    async (colorScheme) => {
      const toolbar = mountToolbar();
      await vi.waitFor(() => expect(toolbar.render().loaded).toBe(true));
      const label = colorScheme === "light" ? "Light" : "Dark";
      click(option(toolbar.open(), label));
      expect(saveBrowserSettings).toHaveBeenCalledExactlyOnceWith({ colorScheme });
      expect(
        find(toolbar.render().tree, (row) => row.props["aria-label"] === "More").props[
          "aria-expanded"
        ],
      ).toBe(false);
      await vi.waitFor(() => expect(stored.colorScheme).toBe(colorScheme));

      const assertSelected = (tree: ReactNode) => {
        expect(option(tree, "Match app").props["aria-checked"]).toBe(false);
        for (const choice of ["Light", "Dark"]) {
          const row = option(tree, choice);
          expect(row.props["aria-checked"]).toBe(choice === label);
          expect(
            rows(row).filter((child) => child.props.className === "browser-workbench-menu-check"),
          ).toHaveLength(choice === label ? 1 : 0);
        }
      };
      assertSelected(toolbar.open());
      toolbar.unmount();
      const recreated = mountToolbar();
      await vi.waitFor(() => expect(recreated.render().settings.colorScheme).toBe(colorScheme));
      assertSelected(recreated.open());
      expect(getBrowserSettings).toHaveBeenCalledTimes(2);
      expect(saveAppearanceSettings).not.toHaveBeenCalled();
    },
  );

  it("moves the selected indicator when switching from Dark to Light and back", async () => {
    stored.colorScheme = "dark";
    const toolbar = mountToolbar();
    await vi.waitFor(() => expect(toolbar.render().settings.colorScheme).toBe("dark"));
    for (const [label, colorScheme] of [
      ["Light", "light"],
      ["Dark", "dark"],
    ] as const) {
      click(option(toolbar.open(), label));
      await vi.waitFor(() => expect(toolbar.render().settings.colorScheme).toBe(colorScheme));
      const tree = toolbar.open();
      expect(option(tree, label).props["aria-checked"]).toBe(true);
      expect(option(tree, label === "Light" ? "Dark" : "Light").props["aria-checked"]).toBe(false);
      click(find(tree, (row) => row.props["aria-label"] === "More"));
    }
    expect(saveBrowserSettings.mock.calls).toEqual([
      [{ colorScheme: "light" }],
      [{ colorScheme: "dark" }],
    ]);
    expect(saveAppearanceSettings).not.toHaveBeenCalled();
  });
});
