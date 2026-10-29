import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

type Props = Record<string, unknown> & { children?: ReactNode; className?: string };

let portalContent: ReactElement<Props> | null = null;

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: ReactElement<Props>) => {
    portalContent = children;
    return children;
  },
}));

const { ConfirmDialog } = await import("../ConfirmDialog");

function findByClass(node: ReactNode, className: string): ReactElement<Props> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Props>(node)) return null;
  if (node.props.className?.split(" ").includes(className)) return node;
  return findByClass(node.props.children, className);
}

type MouseLike = { stopPropagation: () => void };

function handler<T extends unknown[]>(
  element: ReactElement<Props> | null,
  name: string,
): (...args: T) => void {
  const fn = element?.props[name];
  if (typeof fn !== "function") throw new Error(`missing ${name} handler`);
  return fn as (...args: T) => void;
}

function render(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  vi.stubGlobal("document", { body: {} });
  const markup = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      title: "Delete QA Researcher?",
      message: "Existing conversations and history will be kept.",
      confirmLabel: "Delete bot",
      onConfirm,
      onCancel,
      ...props,
    }),
  );
  return { markup, onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    portalContent = null;
  });

  it("renders an alert dialog with the title, message and both actions", () => {
    const { markup } = render();
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Delete QA Researcher?");
    expect(markup).toContain("Existing conversations and history will be kept.");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete bot</button>");
    expect(markup).not.toContain("is-danger");
  });

  it("marks a destructive action and shows extra controls", () => {
    const { markup } = render({
      danger: true,
      children: createElement("label", null, "Also delete its memory"),
    });
    expect(markup).toContain("confirm-dialog-confirm is-danger");
    expect(markup).toContain("confirm-dialog-extra");
    expect(markup).toContain("Also delete its memory");
  });

  it("confirms from the action button and cancels from Cancel", () => {
    const { onConfirm, onCancel } = render();
    const confirm = findByClass(portalContent, "confirm-dialog-confirm");
    const cancel = findByClass(portalContent, "confirm-dialog-cancel");
    handler(confirm, "onClick")();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    handler(cancel, "onClick")();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on a click outside without letting it reach the surface behind", () => {
    const { onCancel } = render();
    const stopPropagation = vi.fn();
    handler<[MouseLike]>(portalContent, "onMouseDown")({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    const card = findByClass(portalContent, "confirm-dialog");
    const cardStop = vi.fn();
    handler<[MouseLike]>(card, "onMouseDown")({ stopPropagation: cardStop });
    expect(cardStop).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
