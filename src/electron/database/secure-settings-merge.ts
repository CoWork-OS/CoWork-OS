/**
 * Three-way merge of a settings value (DB5). `base` is what the writer read, `mine` what
 * it wants to store, `theirs` what another writer stored meanwhile. Fields the writer
 * left as they were take the other writer's value; fields it changed keep its value.
 * Plain objects merge field by field; anything else (arrays, strings, numbers) is one
 * value. When both sides changed the same value differently, the writer's value wins and
 * the path is reported as a conflict.
 */

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
    return true;
  }
  return false;
}

export interface SettingsMergeResult {
  value: Json;
  /** Paths both sides changed differently; the writer's value was kept. */
  conflicts: string[];
}

export function mergeSettingsValues(base: Json, mine: Json, theirs: Json): SettingsMergeResult {
  const conflicts: string[] = [];
  const merge = (b: Json, m: Json, t: Json, pathLabel: string): Json => {
    if (deepEqual(m, b)) return t;
    if (deepEqual(t, b) || deepEqual(m, t)) return m;
    if (isPlainObject(m) && isPlainObject(t)) {
      const baseObject = isPlainObject(b) ? b : {};
      const out: Record<string, Json> = {};
      const keys = new Set([...Object.keys(baseObject), ...Object.keys(m), ...Object.keys(t)]);
      for (const key of keys) {
        const merged = merge(
          baseObject[key],
          m[key],
          t[key],
          pathLabel ? `${pathLabel}.${key}` : key,
        );
        if (merged !== undefined) out[key] = merged;
      }
      return out;
    }
    conflicts.push(pathLabel || "(value)");
    return m;
  };
  return { value: merge(base, mine, theirs, ""), conflicts };
}
