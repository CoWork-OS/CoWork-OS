import { useCallback, useMemo, useState } from "react";

const STORAGE_PREFIX = "cowork:bot-composer:";

function readDraft(scope: string): string {
  if (!scope || typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(`${STORAGE_PREFIX}${scope}`) || "";
  } catch {
    return "";
  }
}

function writeDraft(scope: string, value: string): void {
  if (!scope || typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(`${STORAGE_PREFIX}${scope}`, value.slice(0, 256 * 1024));
    else window.sessionStorage.removeItem(`${STORAGE_PREFIX}${scope}`);
  } catch {
    // Draft persistence is best-effort; in-memory state remains authoritative.
  }
}

export function useScopedComposerState(scope: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingScopes, setSendingScopes] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const draft = useMemo(
    () => (Object.prototype.hasOwnProperty.call(drafts, scope) ? drafts[scope] : readDraft(scope)),
    [drafts, scope],
  );
  const setDraft = useCallback((value: string) => {
    setDrafts((current) => ({ ...current, [scope]: value }));
    writeDraft(scope, value);
  }, [scope]);
  const clearIfUnchanged = useCallback((submitted: string) => {
    setDrafts((current) => {
      const currentValue = Object.prototype.hasOwnProperty.call(current, scope)
        ? current[scope]
        : readDraft(scope);
      if (currentValue !== submitted) return current;
      writeDraft(scope, "");
      return { ...current, [scope]: "" };
    });
  }, [scope]);
  const setSending = useCallback((value: boolean) => {
    setSendingScopes((current) => ({ ...current, [scope]: value }));
  }, [scope]);
  const setError = useCallback((value?: string) => {
    setErrors((current) => ({ ...current, [scope]: value }));
  }, [scope]);

  return {
    draft,
    setDraft,
    clearIfUnchanged,
    sending: Boolean(sendingScopes[scope]),
    setSending,
    error: errors[scope],
    setError,
  };
}
