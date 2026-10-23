/**
 * macOS virtual key codes shared by the local helper keypress parser and remote
 * providers that need to turn a parsed key code back into a key name.
 */

export const MAC_VIRTUAL_KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
};

/** Named (non-character) keys emitted by the macOS keypress parser. */
export const MAC_NAMED_KEY_CODES: Record<string, number> = {
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  pageup: 116,
  end: 119,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

/** Alternate spellings the keypress parser accepts for named keys. */
export const MAC_KEY_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  backspace: "delete",
};

const KEY_NAME_BY_CODE = new Map<number, string>(
  [...Object.entries(MAC_VIRTUAL_KEY_CODES), ...Object.entries(MAC_NAMED_KEY_CODES)].map(
    ([name, code]) => [code, name],
  ),
);

export function macKeyNameForCode(keyCode: number): string | undefined {
  return KEY_NAME_BY_CODE.get(keyCode);
}
