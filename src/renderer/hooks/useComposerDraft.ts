import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  buildComposerDraftKey,
  type ComposerDraft,
  type ComposerDraftKeyInput,
} from "../../shared/composer-drafts";
import { composerDraftStore, type ComposerDraftStore } from "../state/composer-draft-store";

export interface UseComposerDraftOptions extends ComposerDraftKeyInput {
  enabled?: boolean;
  store?: ComposerDraftStore;
}

export function useComposerDraft(options: UseComposerDraftOptions) {
  const {
    scope,
    workspaceId,
    taskId = null,
    surface = "main",
    remoteDeviceId,
    enabled = true,
    store = composerDraftStore,
  } = options;
  const input = useMemo<ComposerDraftKeyInput>(
    () => ({
      scope,
      workspaceId,
      taskId,
      surface,
      ...(remoteDeviceId ? { remoteDeviceId } : {}),
    }),
    [remoteDeviceId, scope, surface, taskId, workspaceId],
  );
  const draftKey = useMemo(() => buildComposerDraftKey(input), [input]);
  const draft = useSyncExternalStore(
    useCallback((listener) => store.subscribe(draftKey, listener), [draftKey, store]),
    useCallback(() => store.get(draftKey), [draftKey, store]),
    () => null,
  );

  useEffect(() => {
    if (!enabled || !workspaceId.trim()) return;
    void store.load(input);
  }, [enabled, input, store, workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    const flush = () => void store.flush(draftKey);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [draftKey, enabled, store]);

  const update = useCallback(
    (
      patch: Partial<
        Pick<ComposerDraft, "text" | "mentions" | "quotedAssistantMessage" | "attachments">
      >,
    ) => store.update(input, patch),
    [input, store],
  );
  const flush = useCallback(() => store.flush(draftKey), [draftKey, store]);
  const clearAfterAccepted = useCallback(
    (submittedRevision: number) => store.clearAfterAccepted(input, submittedRevision),
    [input, store],
  );
  const clearAfterAcceptedDraft = useCallback(
    (submittedDraft: ComposerDraft, submittedRevision: number) =>
      store.clearAfterAcceptedDraft(submittedDraft, submittedRevision),
    [store],
  );

  return { draft, draftKey, update, flush, clearAfterAccepted, clearAfterAcceptedDraft };
}
