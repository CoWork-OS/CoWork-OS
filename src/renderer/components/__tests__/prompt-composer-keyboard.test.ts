import type { ComponentProps, KeyboardEvent, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptComposerInput } from "../PromptComposerInput";

// Invoke the component's actual React callbacks. Effects are inert because
// these keyboard paths do not need layout; a minimal selection supplies the
// native DOM offsets used by the real deletion handler.
const hooks = vi.hoisted(() => ({
  refIndex: 0,
  root: null as unknown,
  useRef(value: unknown) {
    const current = hooks.refIndex++ === 0 ? hooks.root : value;
    return { current };
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: hooks.useRef,
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useImperativeHandle: () => {},
}));

type ComposerProps = ComponentProps<typeof PromptComposerInput>;
type EditorElement = ReactElement<{ onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void }>;

function renderKeyboardHandler(value: string, cursor = value.length) {
  hooks.refIndex = 0;
  const textNode = { nodeType: 3, textContent: value, parentElement: null };
  hooks.root = {
    childNodes: [textNode],
    contains: (node: unknown) => node === textNode,
  };
  vi.stubGlobal("window", {
    getSelection: () => ({
      rangeCount: 1,
      anchorNode: textNode,
      anchorOffset: cursor,
      focusNode: textNode,
      focusOffset: cursor,
    }),
    setTimeout: vi.fn(),
  });
  const send = vi.fn();
  const onKeyDown = vi.fn((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") send();
  });
  const onChange = vi.fn();
  const props: ComposerProps = {
    value,
    mentions: [],
    className: "input-field",
    ariaLabel: "Message",
    onChange,
    onKeyDown,
    onPaste: vi.fn(),
    onCursorChange: vi.fn(),
  };
  const component = PromptComposerInput as unknown as {
    render: (props: ComposerProps, ref: null) => EditorElement;
  };
  const element = component.render(props, null);
  return { handleKeyDown: element.props.onKeyDown, onKeyDown, onChange, send };
}

function keyEvent(
  key: string,
  overrides: Partial<KeyboardEvent<HTMLDivElement>> = {},
): KeyboardEvent<HTMLDivElement> {
  const event = {
    key,
    keyCode: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    defaultPrevented: false,
    ...overrides,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event as unknown as KeyboardEvent<HTMLDivElement>;
}

beforeEach(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", { TEXT_NODE: 3 });
});

afterEach(() => vi.unstubAllGlobals());

describe("composer keyboard callbacks", () => {
  it.each(["Enter", "Tab"])("keeps composing %s away from parent shortcuts", (key) => {
    const composer = renderKeyboardHandler("正在输入");
    const event = keyEvent(key, {
      nativeEvent: { isComposing: true } as KeyboardEvent["nativeEvent"],
    });

    composer.handleKeyDown(event);

    expect(composer.onKeyDown).not.toHaveBeenCalled();
    expect(composer.send).not.toHaveBeenCalled();
    expect(composer.onChange).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps legacy IME keyCode 229 Enter away from Send when isComposing is false", () => {
    const composer = renderKeyboardHandler("変換中");
    const event = keyEvent("Enter", { keyCode: 229 });

    composer.handleKeyDown(event);

    expect(composer.onKeyDown).not.toHaveBeenCalled();
    expect(composer.send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("still sends ordinary Enter through the parent callback", () => {
    const composer = renderKeyboardHandler("Ready to send");

    composer.handleKeyDown(keyEvent("Enter"));

    expect(composer.send).toHaveBeenCalledOnce();
  });

  it.each([
    ["Backspace", "altKey"],
    ["Backspace", "ctrlKey"],
    ["Backspace", "metaKey"],
    ["Delete", "altKey"],
    ["Delete", "ctrlKey"],
    ["Delete", "metaKey"],
  ] as const)("preserves native %s with %s", (key, modifier) => {
    const composer = renderKeyboardHandler("Review this word");
    const event = keyEvent(key, { [modifier]: true });

    composer.handleKeyDown(event);

    expect(composer.onKeyDown).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(composer.onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["Backspace", "Review 😀", 9, "Review "],
    ["Delete", "😀 review", 0, " review"],
  ] as const)("handles plain %s and removes the complete character", (key, value, cursor, next) => {
    const composer = renderKeyboardHandler(value, cursor);
    const event = keyEvent(key);

    composer.handleKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(composer.onChange).toHaveBeenCalledExactlyOnceWith(
      next,
      next === "Review " ? 7 : 0,
      [],
      true,
    );
  });
});
