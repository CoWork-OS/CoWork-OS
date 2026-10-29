import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorProfileView } from "../ConnectorProfileView";
import { PluginStore } from "../PluginStore";
import { PromptMemoryImportWizard } from "../PromptMemoryImportWizard";

// ModalDialog closes the top window on Escape by calling its onClose
// (modal-dialog-escape.test.ts covers that); record which onClose each window hands it.
const rendered = vi.hoisted(() => ({
  dialogs: [] as Array<{ onClose: () => void; className?: string }>,
}));

vi.mock("../ModalDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ModalDialog")>();
  return {
    ...actual,
    ModalDialog: (props: Parameters<typeof actual.ModalDialog>[0]) => {
      rendered.dialogs.push(props);
      return actual.ModalDialog(props);
    },
  };
});

/** Renders a component once and returns the element tree it produced, handlers included. */
function renderTree<P>(component: (props: P) => ReactElement, props: P): ReactElement {
  let tree: ReactElement | null = null;
  function Probe() {
    tree = component(props);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!tree) throw new Error("component rendered nothing");
  return tree;
}

function dialogWithClass(className: string) {
  const dialog = rendered.dialogs.find((props) => props.className === className);
  if (!dialog) throw new Error(`no ModalDialog with class ${className}`);
  return dialog;
}

beforeEach(() => {
  rendered.dialogs = [];
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectorProfileView", () => {
  const props = {
    connector: {
      key: "meshy",
      name: "Meshy",
      registryId: "meshy",
      description: "3D models from text and images",
      supportsOAuth: false,
    },
    config: undefined,
    status: undefined,
    installingId: null,
    connectingServer: null,
    connectionErrors: {},
    onInstall: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onOpenSetup: vi.fn(),
    onOpenEnvModal: vi.fn(),
  };

  it("is a modal dialog that Escape closes", () => {
    const onClose = vi.fn();
    const markup = renderToStaticMarkup(createElement(ConnectorProfileView, { ...props, onClose }));

    expect(markup).toContain(
      '<div aria-label="Meshy" class="cm-profile-modal" role="dialog" aria-modal="true" tabindex="-1">',
    );
    dialogWithClass("cm-profile-modal").onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PluginStore", () => {
  it("is a modal dialog that Escape closes, with a labelled close button", () => {
    const onClose = vi.fn();
    const markup = renderToStaticMarkup(createElement(PluginStore, { onClose }));

    expect(markup).toContain(
      '<div aria-label="Plugin Store" class="ps-container" role="dialog" aria-modal="true" tabindex="-1">',
    );
    expect(markup).toContain('<button class="ps-close" aria-label="Close">×</button>');
    dialogWithClass("ps-container").onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click but not on clicks or drags that start inside the store", () => {
    const onClose = vi.fn();
    const overlay = renderTree(PluginStore, { onClose }) as ReactElement<{
      className: string;
      onMouseDown: (event: { target: object; currentTarget: object }) => void;
      onClick: (event: { target: object; currentTarget: object }) => void;
    }>;
    expect(overlay.props.className).toBe("ps-overlay");
    const backdrop = {};
    const field = {};
    const click = (pressed: object, released: object) => {
      overlay.props.onMouseDown({ target: pressed, currentTarget: backdrop });
      overlay.props.onClick({ target: released, currentTarget: backdrop });
    };

    click(field, field);
    expect(onClose).not.toHaveBeenCalled();
    // Selecting text in a field and letting go over the backdrop clicks the overlay.
    click(field, backdrop);
    expect(onClose).not.toHaveBeenCalled();
    click(backdrop, backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PromptMemoryImportWizard", () => {
  it("is a labelled modal dialog that Escape closes", () => {
    const onClose = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(PromptMemoryImportWizard, { workspaceId: "workspace-1", onClose }),
    );

    expect(markup).toContain(
      '<div class="mcp-modal memory-text-import-modal" aria-labelledby="memory-text-import-title" role="dialog" aria-modal="true" tabindex="-1">',
    );
    dialogWithClass("mcp-modal memory-text-import-modal").onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
