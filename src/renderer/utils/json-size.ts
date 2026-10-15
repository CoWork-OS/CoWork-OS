/**
 * UTF-8 size of `JSON.stringify(value)`, computed without building the string.
 *
 * Sizes of objects and arrays are memoized by identity, so measuring a timeline again
 * after a page or a live event arrives only walks the new objects; events and their
 * payloads are shared between the timeline, its projection and the caches. Measured
 * values must not be mutated afterwards, as React state already isn't. Cyclic values,
 * which JSON.stringify rejects, measure as Infinity.
 */
const objectSizes = new WeakMap<object, number>();

export function estimateJsonBytes(value: unknown): number {
  return measure(value, new Set());
}

function measure(value: unknown, visiting: Set<object>): number {
  switch (typeof value) {
    case "string":
      return stringBytes(value);
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "bigint":
      // JSON.stringify throws on BigInt.
      return Number.POSITIVE_INFINITY;
    case "object":
      break;
    default:
      // undefined, functions and symbols are dropped (in arrays they become null).
      return 0;
  }
  if (value === null) return 4;
  const cached = objectSizes.get(value);
  if (cached !== undefined) return cached;
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return measure(withToJson.toJSON(), visiting);
  }
  if (visiting.has(value)) return Number.POSITIVE_INFINITY;
  visiting.add(value);
  let bytes = 2; // [] or {}
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) bytes += 1;
      const item = value[index];
      const itemType = typeof item;
      bytes +=
        item === undefined || itemType === "function" || itemType === "symbol"
          ? 4
          : measure(item, visiting);
    }
  } else {
    let first = true;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      const itemType = typeof item;
      if (item === undefined || itemType === "function" || itemType === "symbol") continue;
      if (!first) bytes += 1;
      first = false;
      bytes += stringBytes(key) + 1 + measure(item, visiting);
    }
  }
  visiting.delete(value);
  if (Number.isFinite(bytes)) objectSizes.set(value, bytes);
  return bytes;
}

/** Quoted, escaped UTF-8 length of a JSON string. */
function stringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      if (code === 0x22 || code === 0x5c) bytes += 2;
      else if (code >= 0x20) bytes += 1;
      // \b \t \n \f \r have short escapes; other control characters become \u00XX.
      else bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6; // lone surrogate, escaped as \uXXXX
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
