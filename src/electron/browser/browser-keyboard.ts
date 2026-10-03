/**
 * US keyboard definitions for CDP Input.dispatchKeyEvent. A key event needs
 * key, code, keyCode and (for printable keys) text for the page to run the
 * default action: Enter with text "\r" submits a form, Tab moves focus.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
const KEY_ALIASES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "Space",
  spacebar: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  shift: "Shift",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
};
export const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const PUNCTUATION_KEY_CODES: Record<string, [string, number]> = {
  ";": ["Semicolon", 186],
  "=": ["Equal", 187],
  ",": ["Comma", 188],
  "-": ["Minus", 189],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
  "[": ["BracketLeft", 219],
  "\\": ["Backslash", 220],
  "]": ["BracketRight", 221],
  "'": ["Quote", 222],
};

/** Key definition for a single key name or printable character, or null. */
export function resolveKeyDefinition(name: string): KeyDefinition | null {
  if (!name) return null;
  if (name === " ") return NAMED_KEYS.Space;
  if (NAMED_KEYS[name]) return NAMED_KEYS[name];
  const alias = KEY_ALIASES[name.toLowerCase()];
  if (alias) return NAMED_KEYS[alias];
  const fnKey = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fnKey) {
    const index = Number(fnKey[1]);
    return { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };
  }
  if (name === "\n" || name === "\r") return NAMED_KEYS.Enter;
  if ([...name].length !== 1) return null;
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  }
  const punctuation = PUNCTUATION_KEY_CODES[name];
  if (punctuation) {
    return { key: name, code: punctuation[0], keyCode: punctuation[1], text: name };
  }
  const codePoint = name.codePointAt(0) || 0;
  if (codePoint >= 0x20 && codePoint !== 0x7f)
    return { key: name, code: "", keyCode: 0, text: name };
  return null;
}

/** Parse "Enter", "Shift+Tab", "Control+a", "Meta++" into modifiers and a main key. */
export function parseKeyCombo(
  combo: string,
): { modifiers: KeyDefinition[]; key: KeyDefinition } | null {
  const value = String(combo ?? "");
  if (!value) return null;
  if (value.length === 1) {
    const single = resolveKeyDefinition(value);
    return single ? { modifiers: [], key: single } : null;
  }
  const parts = value.split("+");
  if (value.endsWith("+")) {
    parts.splice(parts.length - 2, 2, "+");
  }
  const keyName = parts.pop() || "";
  const key = resolveKeyDefinition(keyName);
  if (!key) return null;
  const modifiers: KeyDefinition[] = [];
  for (const part of parts) {
    const modifier = resolveKeyDefinition(part.trim());
    if (!modifier || MODIFIER_BITS[modifier.key] === undefined) return null;
    modifiers.push(modifier);
  }
  return { modifiers, key };
}
