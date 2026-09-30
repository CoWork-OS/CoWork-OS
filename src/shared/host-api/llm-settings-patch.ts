export interface LLMSettingsFieldChange {
  path: string[];
  value: unknown;
}

export interface LLMSettingsPatch {
  set: LLMSettingsFieldChange[];
  remove: string[][];
  replaceSecrets: Array<LLMSettingsFieldChange & { value: string }>;
}

const SECRET_KEY =
  /(?:api.?key|access.?key|secret|password|credential|authorization|bearer|subscription.?token|access.?token|refresh.?token|id.?token)/i;
const HOST_ONLY_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "tokenExpiresAt",
  "tokenEndpoint",
  "idToken",
  "accountId",
  "email",
  "chatgptPlanType",
]);
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretConfiguredMarker(key: string): boolean {
  return key.endsWith("Configured") && SECRET_KEY.test(key.slice(0, -"Configured".length));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function isSafePath(path: string[]): boolean {
  return (
    path.length > 0 &&
    path.length <= 16 &&
    path.every(
      (segment) =>
        segment.length > 0 && segment.length <= 200 && !FORBIDDEN_PATH_SEGMENTS.has(segment),
    )
  );
}

/**
 * Turn the desktop Settings form's full draft into a minimal, secret-safe web
 * mutation. The host snapshot contains presence flags instead of credentials,
 * so only a non-empty value typed into a secret field becomes a replacement.
 */
export function createLLMSettingsPatch(incoming: unknown, baseline: unknown): LLMSettingsPatch {
  const patch: LLMSettingsPatch = { set: [], remove: [], replaceSecrets: [] };

  const visit = (
    key: string,
    next: unknown,
    current: unknown,
    currentExists: boolean,
    path: string[],
  ) => {
    if (isSecretConfiguredMarker(key) || HOST_ONLY_KEYS.has(key)) return;
    if (FORBIDDEN_PATH_SEGMENTS.has(key)) return;
    const nextPath = [...path, key];
    const leaf = nextPath[nextPath.length - 1];

    if (leaf === "clearApiKey") {
      if (typeof next === "boolean" && !valuesEqual(next, current)) {
        patch.set.push({ path: nextPath, value: next });
      }
      return;
    }

    if (next === undefined) {
      if (currentExists && !SECRET_KEY.test(leaf) && isSafePath(nextPath)) {
        patch.remove.push(nextPath);
      }
      return;
    }

    if (SECRET_KEY.test(leaf)) {
      if (
        typeof next === "string" &&
        next.trim().length > 0 &&
        !valuesEqual(next, current) &&
        isSafePath(nextPath)
      ) {
        patch.replaceSecrets.push({ path: nextPath, value: next.trim() });
      }
      return;
    }

    if (isRecord(next)) {
      const currentRecord = isRecord(current) ? current : {};
      for (const [childKey, childValue] of Object.entries(next)) {
        visit(
          childKey,
          childValue,
          currentRecord[childKey],
          Object.hasOwn(currentRecord, childKey),
          nextPath,
        );
      }
      return;
    }

    if (!valuesEqual(next, current) && isSafePath(nextPath)) {
      patch.set.push({ path: nextPath, value: next });
    }
  };

  const currentRecord = isRecord(baseline) ? baseline : {};
  if (!isRecord(incoming)) return patch;
  for (const [key, value] of Object.entries(incoming)) {
    visit(key, value, currentRecord[key], Object.hasOwn(currentRecord, key), []);
  }

  return patch;
}
