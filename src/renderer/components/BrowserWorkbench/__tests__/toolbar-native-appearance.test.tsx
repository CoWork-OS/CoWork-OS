import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarMenu } from "../ToolbarMenu";

const hooks = vi.hoisted(() => ({ open: false }));
// Simulate hook storage only; exercise the component's real controls and IPC handlers.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => [
    hooks.open,
    (next: boolean) => {
      hooks.open = next;
    },
  ],
  useRef: () => ({ current: { getBoundingClientRect: () => ({ left: 120, bottom: 50 }) } }),
  useEffect: () => undefined,
}));

type Row = ReactElement<{
  children?: ReactNode;
  role?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  onClick?: () => void;
}>;

function rows(node: ReactNode): Row[] {
  if (Array.isArray(node)) return node.flatMap(rows);
  if (!isValidElement<Row["props"]>(node)) return [];
  return [node, ...rows(node.props.children)];
}

const popup = vi.fn();
function harness(overrides: Partial<ComponentProps<typeof ToolbarMenu>> = {}) {
  const props: ComponentProps<typeof ToolbarMenu> = {
    hasPage: true,
    nativeMenu: true,
    colorScheme: null,
    onColorScheme: vi.fn(),
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
    ...overrides,
  };
  const render = () => ToolbarMenu(props);
  const button = () => rows(render()).find((row) => row.props["aria-label"] === "More")!;
  return { open: () => button().props.onClick!(), render, button };
}

beforeEach(() => {
  hooks.open = false;
  popup.mockReset();
  vi.stubGlobal("window", { electronAPI: { popupBrowserToolbarMenu: popup } });
});
afterEach(() => vi.unstubAllGlobals());

describe("native toolbar appearance compatibility", () => {
  it.each([
    ["appearance:app", null],
    ["appearance:light", "light"],
    ["appearance:dark", "dark"],
  ] as const)("routes %s through the existing appearance handler", async (action, choice) => {
    const onColorScheme = vi.fn();
    popup.mockResolvedValue(action);
    const menu = harness({ colorScheme: "dark", onColorScheme });
    menu.open();
    await vi.waitFor(() => expect(onColorScheme).toHaveBeenCalledExactlyOnceWith(choice));
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: "dark" }));
    expect(menu.button().props["aria-expanded"]).toBe(false);
  });

  it("shows native Match app controls when the configured choice follows the app", async () => {
    popup.mockResolvedValue(null);
    harness({ colorScheme: null, onColorScheme: vi.fn() }).open();
    await vi.waitFor(() => expect(popup).toHaveBeenCalledOnce());
    expect(popup.mock.calls[0][0].colorScheme).toBeNull();
  });

  it("does not offer appearance actions to clients without an appearance handler", async () => {
    popup.mockResolvedValue(null);
    harness({ colorScheme: "dark", onColorScheme: undefined }).open();
    await vi.waitFor(() => expect(popup).toHaveBeenCalledOnce());
    expect(popup.mock.calls[0][0].colorScheme).toBeUndefined();
  });

  it("keeps the HTML overlay absent while the native menu is open and leaves appearance unchanged on cancellation", async () => {
    let close!: (action: null) => void;
    popup.mockReturnValue(
      new Promise<null>((resolve) => {
        close = resolve;
      }),
    );
    const onColorScheme = vi.fn();
    const menu = harness({ colorScheme: "light", onColorScheme });
    menu.open();
    expect(menu.button().props["aria-expanded"]).toBe(true);
    expect(rows(menu.render()).some((row) => row.props.role === "menu")).toBe(false);
    close(null);
    await vi.waitFor(() => expect(menu.button().props["aria-expanded"]).toBe(false));
    expect(onColorScheme).not.toHaveBeenCalled();
  });
});
