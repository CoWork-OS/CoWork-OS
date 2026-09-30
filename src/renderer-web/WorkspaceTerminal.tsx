import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import type { WebSessionBootstrap } from "../shared/host-api/contracts";
import { BrowserHostTransport, WebTransportError } from "./transport";
import "@xterm/xterm/css/xterm.css";
import "./WorkspaceTerminal.css";

type TerminalTab = {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

type TerminalAttachment = {
  attachmentId: string;
  writer: boolean;
};

type AttachResult = TerminalAttachment & {
  tab: TerminalTab;
  nextOffset: number;
  gap?: OutputGap;
};

type OutputGap = { from: number; to: number };

type ReplayPage = {
  chunks: Array<{ offset: number; text: string }>;
  nextOffset: number;
  hasMore: boolean;
  gap?: OutputGap;
};

type TerminalHandle = {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposables: Array<{ dispose: () => void }>;
};

type AttachAttempt = { operationKey: string; running: boolean };
type OpenAttempt = {
  operationKey: string;
  title: string;
  running: boolean;
  scopeKey: string;
  taskId: string;
  workspaceId: string;
  createdAt: number;
};
type CloseAttempt = { operationKey: string; attachmentId: string; running: boolean };
type InputOperation = {
  operationKey: string;
  input: string;
  attachmentId?: string;
  taskId: string;
  workspaceId: string;
  scopeKey: string;
};
type ResizeDimensions = { cols: number; rows: number };
type ResizeState = {
  pending: (ResizeDimensions & { operationKey: string; attachmentId?: string }) | null;
  latest: ResizeDimensions | null;
  running: boolean;
};

const MAX_QUEUED_INPUT_CHARS = 512 * 1024;
const REPLAY_LIMIT = 16 * 1024;
const OPEN_RECEIPT_RETRY_WINDOW_MS = 9 * 60_000;
export const PENDING_TERMINAL_OPEN_STORAGE_PREFIX = "cowork.web.terminal.pending-open.v1.";

/** Call during sign-out to clear this browser's unresolved terminal-open keys. */
export function clearPendingWorkspaceTerminalOpens(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PENDING_TERMINAL_OPEN_STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
}

export function WorkspaceTerminal({
  taskId,
  workspaceId,
  session,
  transport,
  connected,
}: {
  taskId: string;
  workspaceId: string;
  session: WebSessionBootstrap;
  transport: BrowserHostTransport | null;
  connected: boolean;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingOpen, setPendingOpen] = useState(false);
  const [openRecoveryExpired, setOpenRecoveryExpired] = useState(false);
  const [shellUnavailable, setShellUnavailable] = useState(false);
  const [attachmentStates, setAttachmentStates] = useState<Record<string, TerminalAttachment>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const scopeKey = useMemo(
    () => `${taskId}\u0000${workspaceId}\u0000${session.host.generation}`,
    [taskId, workspaceId, session.host.generation],
  );
  const openStorageKey = useMemo(
    () =>
      `${PENDING_TERMINAL_OPEN_STORAGE_PREFIX}${[
        session.host.installationId,
        session.host.generation,
        taskId,
        workspaceId,
      ]
        .map(encodeURIComponent)
        .join(".")}`,
    [session.host.generation, session.host.installationId, taskId, workspaceId],
  );

  const terminalHandlesRef = useRef(new Map<string, TerminalHandle>());
  const terminalElementsRef = useRef(new Map<string, HTMLDivElement>());
  const outputBufferRef = useRef(new Map<string, string[]>());
  const attachmentsRef = useRef(new Map<string, TerminalAttachment>());
  const cursorsRef = useRef(new Map<string, number>());
  const tabsRef = useRef<TerminalTab[]>([]);
  const scopeRunRef = useRef(0);
  const connectedRef = useRef(connected);
  const transportRef = useRef(transport);
  const scopeKeyRef = useRef(scopeKey);
  const operationScopeRef = useRef({ taskId, workspaceId });
  const attachAttemptsRef = useRef(new Map<string, AttachAttempt>());
  const openAttemptRef = useRef<OpenAttempt | null>(null);
  const closeAttemptsRef = useRef(new Map<string, CloseAttempt>());
  const inputQueuesRef = useRef(new Map<string, InputOperation[]>());
  const inputQueueCharsRef = useRef(new Map<string, number>());
  const inputFlushesRef = useRef(new Set<string>());
  const resizeStatesRef = useRef(new Map<string, ResizeState>());
  const replayTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const replayBusyRef = useRef(new Set<string>());
  const replayRef = useRef<(tabId: string) => Promise<void>>(async () => {});
  const scheduleReplayRef = useRef<(tabId: string, delayMs: number) => void>(() => {});
  const inputRef = useRef<(tabId: string, input: string) => void>(() => {});
  const resizeRef = useRef<(tabId: string, dimensions: ResizeDimensions) => void>(() => {});
  const flushInputRef = useRef<(tabId: string) => Promise<void>>(async () => {});
  const flushResizeRef = useRef<(tabId: string) => Promise<void>>(async () => {});
  const closeRef = useRef<(tabId: string) => Promise<void>>(async () => {});

  const capability = session.capabilities?.["terminal.attach"];
  const terminalAvailable = capability?.available === true;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  tabsRef.current = tabs;
  connectedRef.current = connected;
  transportRef.current = transport;
  scopeKeyRef.current = scopeKey;
  operationScopeRef.current = { taskId, workspaceId };

  const showError = useCallback((message: string) => {
    setError((current) => (current === message ? current : message));
  }, []);

  const disposeTerminal = useCallback((tabId: string) => {
    const handle = terminalHandlesRef.current.get(tabId);
    if (!handle) return;
    for (const disposable of handle.disposables) disposable.dispose();
    handle.terminal.dispose();
    terminalHandlesRef.current.delete(tabId);
    terminalElementsRef.current.delete(tabId);
    outputBufferRef.current.delete(tabId);
  }, []);

  const clearReplayTimer = useCallback((tabId: string) => {
    const timer = replayTimersRef.current.get(tabId);
    if (timer) clearTimeout(timer);
    replayTimersRef.current.delete(tabId);
  }, []);

  const detachBestEffort = useCallback(
    (
      targetTransport: BrowserHostTransport,
      scope: { taskId: string; workspaceId: string },
      force = false,
    ) => {
      const retained = new Map<string, TerminalAttachment>();
      for (const [tabId, attachment] of attachmentsRef.current) {
        const hasQueuedInput = (inputQueuesRef.current.get(tabId)?.length ?? 0) > 0;
        const resizeState = resizeStatesRef.current.get(tabId);
        const hasPendingResize = Boolean(
          resizeState?.pending || resizeState?.latest || resizeState?.running,
        );
        const closeUncertain = closeAttemptsRef.current.has(tabId);
        if (
          !force &&
          (!connectedRef.current || hasQueuedInput || hasPendingResize || closeUncertain)
        ) {
          retained.set(tabId, attachment);
          clearReplayTimer(tabId);
          continue;
        }
        const operationKey = crypto.randomUUID();
        void targetTransport
          .request(
            "terminal.detach",
            {
              ...scope,
              attachmentId: attachment.attachmentId,
            },
            { mutation: true, operationKey },
          )
          .catch(() => undefined);
        clearReplayTimer(tabId);
      }
      attachmentsRef.current.clear();
      for (const [tabId, attachment] of retained) attachmentsRef.current.set(tabId, attachment);
      setAttachmentStates(Object.fromEntries(retained));
    },
    [clearReplayTimer],
  );

  const parseList = useCallback(
    (value: unknown): TerminalTab[] => parseTerminalList(value, taskId, workspaceId),
    [taskId, workspaceId],
  );

  const runAttach = useCallback(
    async (tab: TerminalTab) => {
      if (!transport || !connected || !terminalAvailable) return;
      let attempt = attachAttemptsRef.current.get(tab.id);
      if (!attempt) {
        attempt = { operationKey: crypto.randomUUID(), running: false };
        attachAttemptsRef.current.set(tab.id, attempt);
      }
      if (attempt.running) return;
      attempt.running = true;
      const operationKey = attempt.operationKey;
      try {
        const result = parseAttachResult(
          await transport.request<unknown>(
            "terminal.attach",
            { taskId, workspaceId, tabId: tab.id },
            { mutation: true, operationKey },
          ),
          tab.id,
        );
        if (scopeKeyRef.current !== scopeKey) {
          attempt.running = false;
          void transport
            .request(
              "terminal.detach",
              { taskId, workspaceId, attachmentId: result.attachmentId },
              { mutation: true, operationKey: crypto.randomUUID() },
            )
            .catch(() => undefined);
          return;
        }
        attachmentsRef.current.set(tab.id, {
          attachmentId: result.attachmentId,
          writer: result.writer,
        });
        attachAttemptsRef.current.delete(tab.id);
        setAttachmentStates((current) => ({
          ...current,
          [tab.id]: { attachmentId: result.attachmentId, writer: result.writer },
        }));
        setError("");
        scheduleReplayRef.current(tab.id, 0);
        void flushInputRef.current(tab.id);
        void flushResizeRef.current(tab.id);
        if (closeAttemptsRef.current.has(tab.id)) void closeRef.current(tab.id);
      } catch (cause) {
        attempt.running = false;
        showError(messageOf(cause, "Could not attach to this terminal."));
      }
    },
    [connected, scopeKey, showError, taskId, terminalAvailable, transport, workspaceId],
  );

  const runOpen = useCallback(async () => {
    const attempt = openAttemptRef.current;
    if (
      !attempt ||
      attempt.scopeKey !== scopeKey ||
      attempt.running ||
      !transport ||
      !connected ||
      !terminalAvailable
    ) {
      return;
    }
    if (Date.now() - attempt.createdAt >= OPEN_RECEIPT_RETRY_WINDOW_MS) {
      setOpenRecoveryExpired(true);
      setPendingOpen(false);
      showError(
        "A previous terminal open may have completed, but its retry receipt expired. Check the terminal list before opening another.",
      );
      return;
    }
    attempt.running = true;
    setPendingOpen(true);
    try {
      const result = parseAttachResult(
        await transport.request<unknown>(
          "terminal.open",
          { taskId: attempt.taskId, workspaceId: attempt.workspaceId, title: attempt.title },
          { mutation: true, operationKey: attempt.operationKey },
        ),
      );
      if (scopeKeyRef.current !== attempt.scopeKey) {
        attempt.running = false;
        return;
      }
      const existingTab = tabsRef.current.find((tab) => tab.id === result.tab.id);
      setTabs((current) =>
        current.some((tab) => tab.id === result.tab.id) ? current : [...current, result.tab],
      );
      setActiveTabId(result.tab.id);
      attachmentsRef.current.set(result.tab.id, {
        attachmentId: result.attachmentId,
        writer: result.writer,
      });
      attachAttemptsRef.current.delete(result.tab.id);
      setAttachmentStates((current) => ({
        ...current,
        [result.tab.id]: { attachmentId: result.attachmentId, writer: result.writer },
      }));
      if (!existingTab) cursorsRef.current.set(result.tab.id, 0);
      openAttemptRef.current = null;
      setPendingOpen(false);
      setOpenRecoveryExpired(false);
      try {
        sessionStorage.removeItem(openStorageKey);
      } catch {
        // Storage may be unavailable in a restricted browser context.
      }
      setError("");
      scheduleReplayRef.current(result.tab.id, 0);
    } catch (cause) {
      attempt.running = false;
      if (!isRetryableMutationFailure(cause)) {
        openAttemptRef.current = null;
        setPendingOpen(false);
        try {
          sessionStorage.removeItem(openStorageKey);
        } catch {
          // Storage may be unavailable in a restricted browser context.
        }
      }
      showError(messageOf(cause, "Could not open a terminal."));
    }
  }, [
    connected,
    openStorageKey,
    scopeKey,
    showError,
    taskId,
    terminalAvailable,
    transport,
    workspaceId,
  ]);

  const runClose = useCallback(
    async (tabId: string) => {
      const attachment = attachmentsRef.current.get(tabId);
      if (!transport || !connected || !attachment?.writer) return;
      let attempt = closeAttemptsRef.current.get(tabId);
      if (!attempt || attempt.attachmentId !== attachment.attachmentId) {
        attempt = {
          operationKey: crypto.randomUUID(),
          attachmentId: attachment.attachmentId,
          running: false,
        };
        closeAttemptsRef.current.set(tabId, attempt);
      }
      if (attempt.running) return;
      attempt.running = true;
      try {
        await transport.request(
          "terminal.close",
          { taskId, workspaceId, attachmentId: attachment.attachmentId },
          { mutation: true, operationKey: attempt.operationKey },
        );
        closeAttemptsRef.current.delete(tabId);
        attachmentsRef.current.delete(tabId);
        attachAttemptsRef.current.delete(tabId);
        clearReplayTimer(tabId);
        disposeTerminal(tabId);
        cursorsRef.current.delete(tabId);
        inputQueuesRef.current.delete(tabId);
        inputQueueCharsRef.current.delete(tabId);
        resizeStatesRef.current.delete(tabId);
        setAttachmentStates((current) => {
          const next = { ...current };
          delete next[tabId];
          return next;
        });
        setTabs((current) => current.filter((tab) => tab.id !== tabId));
        setActiveTabId((current) => {
          if (current !== tabId) return current;
          return tabsRef.current.find((tab) => tab.id !== tabId)?.id ?? null;
        });
        setError("");
      } catch (cause) {
        attempt.running = false;
        showError(messageOf(cause, "Could not close this terminal."));
      }
    },
    [clearReplayTimer, connected, disposeTerminal, showError, taskId, transport, workspaceId],
  );

  const queueInput = useCallback(
    (tabId: string, input: string) => {
      if (!input) return;
      if (!attachmentsRef.current.get(tabId)?.writer) {
        showError("This terminal is read only while another browser controls input.");
        return;
      }
      const chunks = splitInput(input, 16 * 1024);
      const queuedChars = inputQueueCharsRef.current.get(tabId) ?? 0;
      const requestedChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (queuedChars + requestedChars > MAX_QUEUED_INPUT_CHARS) {
        showError("Terminal input is paused because its offline queue is full.");
        return;
      }
      const queue = inputQueuesRef.current.get(tabId) ?? [];
      for (const chunk of chunks) {
        queue.push({
          operationKey: crypto.randomUUID(),
          input: chunk,
          taskId,
          workspaceId,
          scopeKey,
        });
      }
      inputQueuesRef.current.set(tabId, queue);
      inputQueueCharsRef.current.set(tabId, queuedChars + requestedChars);
      void flushInputRef.current(tabId);
    },
    [scopeKey, showError, taskId, workspaceId],
  );

  const flushInput = useCallback(
    async (tabId: string) => {
      if (!transport || !connected || inputFlushesRef.current.has(tabId)) return;
      const attachment = attachmentsRef.current.get(tabId);
      const queue = inputQueuesRef.current.get(tabId);
      if (!attachment?.writer || !queue?.length) return;
      inputFlushesRef.current.add(tabId);
      try {
        while (connectedRef.current && transportRef.current && queue.length) {
          const currentAttachment = attachmentsRef.current.get(tabId);
          const operation = queue[0];
          if (!currentAttachment?.writer || !operation) return;
          if (operation.scopeKey !== scopeKeyRef.current) {
            queue.shift();
            inputQueueCharsRef.current.set(
              tabId,
              Math.max(0, (inputQueueCharsRef.current.get(tabId) ?? 0) - operation.input.length),
            );
            showError(
              "The selected task changed before terminal input was confirmed. Pending input was discarded.",
            );
            continue;
          }
          operation.attachmentId ??= currentAttachment.attachmentId;
          if (operation.attachmentId !== currentAttachment.attachmentId) {
            queue.shift();
            inputQueueCharsRef.current.set(
              tabId,
              Math.max(0, (inputQueueCharsRef.current.get(tabId) ?? 0) - operation.input.length),
            );
            showError(
              "Terminal input could not be confirmed before its attachment expired, so it was not replayed.",
            );
            continue;
          }
          try {
            await transportRef.current.request(
              "terminal.input",
              {
                taskId: operation.taskId,
                workspaceId: operation.workspaceId,
                attachmentId: operation.attachmentId,
                input: operation.input,
              },
              { mutation: true, operationKey: operation.operationKey },
            );
            if (queue[0]?.operationKey === operation.operationKey) {
              queue.shift();
              inputQueueCharsRef.current.set(
                tabId,
                Math.max(0, (inputQueueCharsRef.current.get(tabId) ?? 0) - operation.input.length),
              );
            }
          } catch (cause) {
            showError(messageOf(cause, "Terminal input could not be confirmed."));
            return;
          }
        }
        if (!queue.length) setError("");
      } finally {
        inputFlushesRef.current.delete(tabId);
      }
    },
    [connected, showError, transport],
  );

  const flushResize = useCallback(
    async (tabId: string) => {
      if (!transport || !connected) return;
      const attachment = attachmentsRef.current.get(tabId);
      if (!attachment?.writer) return;
      const state = resizeStatesRef.current.get(tabId);
      if (!state || state.running) return;
      if (!state.pending && state.latest) {
        state.pending = {
          ...state.latest,
          operationKey: crypto.randomUUID(),
          attachmentId: attachment.attachmentId,
        };
        state.latest = null;
      }
      if (state.pending?.attachmentId && state.pending.attachmentId !== attachment.attachmentId) {
        state.pending = {
          cols: state.pending.cols,
          rows: state.pending.rows,
          attachmentId: attachment.attachmentId,
          operationKey: crypto.randomUUID(),
        };
      }
      const pending = state.pending;
      if (!pending) return;
      state.running = true;
      let completed = false;
      try {
        await transportRef.current?.request(
          "terminal.resize",
          {
            ...operationScopeRef.current,
            attachmentId: pending.attachmentId,
            cols: pending.cols,
            rows: pending.rows,
          },
          { mutation: true, operationKey: pending.operationKey },
        );
        if (state.pending?.operationKey === pending.operationKey) state.pending = null;
        completed = true;
        if (!state.latest) setError("");
      } catch (cause) {
        showError(messageOf(cause, "Terminal size could not be confirmed."));
      } finally {
        state.running = false;
        if (completed && state.latest) void flushResizeRef.current(tabId);
      }
    },
    [connected, showError, transport],
  );

  const pushOutput = useCallback((tabId: string, text: string) => {
    if (!text) return;
    const handle = terminalHandlesRef.current.get(tabId);
    if (handle) {
      handle.terminal.write(text);
      return;
    }
    const pending = outputBufferRef.current.get(tabId) ?? [];
    pending.push(text);
    outputBufferRef.current.set(tabId, pending);
  }, []);

  const scheduleReplay = useCallback(
    (tabId: string, delayMs: number) => {
      clearReplayTimer(tabId);
      const timer = setTimeout(() => {
        replayTimersRef.current.delete(tabId);
        void replayRef.current(tabId);
      }, delayMs);
      replayTimersRef.current.set(tabId, timer);
    },
    [clearReplayTimer],
  );

  const replayTab = useCallback(
    async (tabId: string) => {
      if (!transport || !connected || replayBusyRef.current.has(tabId)) return;
      const attachment = attachmentsRef.current.get(tabId);
      if (!attachment) return;
      replayBusyRef.current.add(tabId);
      let delay = 400;
      try {
        let cursor = cursorsRef.current.get(tabId) ?? 0;
        const page = parseReplayPage(
          await transport.request<unknown>("terminal.replay", {
            taskId,
            workspaceId,
            attachmentId: attachment.attachmentId,
            afterOffset: cursor,
            limit: REPLAY_LIMIT,
          }),
        );
        if (page.gap) {
          if (page.gap.from > cursor) {
            pushOutput(tabId, `\r\n[terminal output ${cursor}–${page.gap.from} unavailable]\r\n`);
          }
          if (page.gap.to > Math.max(cursor, page.gap.from)) {
            pushOutput(tabId, `\r\n[terminal output ${page.gap.from}–${page.gap.to} omitted]\r\n`);
          }
          cursor = Math.max(cursor, page.gap.to);
        }
        for (const chunk of page.chunks) {
          const end = chunk.offset + chunk.text.length;
          if (end <= cursor) continue;
          if (chunk.offset > cursor) {
            pushOutput(tabId, `\r\n[terminal output ${cursor}–${chunk.offset} omitted]\r\n`);
            cursor = chunk.offset;
          }
          const skip = Math.max(0, cursor - chunk.offset);
          const text = chunk.text.slice(skip);
          if (text) {
            pushOutput(tabId, text);
            cursor += text.length;
          }
        }
        if (!page.chunks.length && page.nextOffset > cursor) {
          pushOutput(tabId, `\r\n[terminal output ${cursor}–${page.nextOffset} omitted]\r\n`);
          cursor = page.nextOffset;
        }
        cursorsRef.current.set(tabId, cursor);
        if (page.hasMore) delay = 0;
      } catch (cause) {
        if (connectedRef.current) showError(messageOf(cause, "Could not read terminal output."));
        delay = 1200;
      } finally {
        replayBusyRef.current.delete(tabId);
        if (connectedRef.current && attachmentsRef.current.has(tabId)) {
          scheduleReplayRef.current(tabId, delay);
        }
      }
    },
    [connected, pushOutput, showError, taskId, transport, workspaceId],
  );

  replayRef.current = replayTab;
  scheduleReplayRef.current = scheduleReplay;
  inputRef.current = queueInput;
  resizeRef.current = (tabId, dimensions) => {
    const state = resizeStatesRef.current.get(tabId) ?? {
      pending: null,
      latest: null,
      running: false,
    };
    state.latest = dimensions;
    resizeStatesRef.current.set(tabId, state);
    void flushResizeRef.current(tabId);
  };
  flushInputRef.current = flushInput;
  flushResizeRef.current = flushResize;

  const refreshTabs = useCallback(
    async (runId: number) => {
      if (!transport || !connected || !terminalAvailable) return;
      setLoading(true);
      setShellUnavailable(false);
      try {
        const nextTabs = parseList(
          await transport.request<unknown>("terminal.list", { taskId, workspaceId }),
        );
        if (scopeRunRef.current !== runId || !connectedRef.current) return;
        setTabs(nextTabs);
        setActiveTabId((current) =>
          current && nextTabs.some((tab) => tab.id === current)
            ? current
            : (nextTabs[0]?.id ?? null),
        );
        const liveIds = new Set(nextTabs.map((tab) => tab.id));
        const knownTabIds = new Set<string>();
        for (const tabId of terminalHandlesRef.current.keys()) knownTabIds.add(tabId);
        for (const tabId of attachmentsRef.current.keys()) knownTabIds.add(tabId);
        for (const tabId of attachAttemptsRef.current.keys()) knownTabIds.add(tabId);
        for (const tabId of closeAttemptsRef.current.keys()) knownTabIds.add(tabId);
        for (const tabId of knownTabIds) {
          if (!liveIds.has(tabId)) {
            clearReplayTimer(tabId);
            attachmentsRef.current.delete(tabId);
            cursorsRef.current.delete(tabId);
            attachAttemptsRef.current.delete(tabId);
            closeAttemptsRef.current.delete(tabId);
            inputQueuesRef.current.delete(tabId);
            inputQueueCharsRef.current.delete(tabId);
            resizeStatesRef.current.delete(tabId);
            disposeTerminal(tabId);
          }
        }
        setAttachmentStates((current) =>
          Object.fromEntries(Object.entries(current).filter(([tabId]) => liveIds.has(tabId))),
        );
        for (const tab of nextTabs) {
          void runAttach(tab);
          if (closeAttemptsRef.current.has(tab.id) && attachmentsRef.current.has(tab.id)) {
            void runClose(tab.id);
          }
        }
        setError("");
      } catch (cause) {
        if (scopeRunRef.current === runId) {
          if (cause instanceof WebTransportError && cause.code === "FORBIDDEN") {
            setShellUnavailable(true);
            setTabs([]);
            setActiveTabId(null);
            setError("");
            detachBestEffort(transport, { taskId, workspaceId }, true);
          } else {
            setError(messageOf(cause, "Could not load workspace terminals."));
          }
        }
      } finally {
        if (scopeRunRef.current === runId) setLoading(false);
      }
    },
    [
      clearReplayTimer,
      connected,
      detachBestEffort,
      disposeTerminal,
      parseList,
      runAttach,
      runClose,
      taskId,
      terminalAvailable,
      transport,
      workspaceId,
    ],
  );

  const openTerminal = useCallback(() => {
    if (!connected || !transport || !terminalAvailable || shellUnavailable || openRecoveryExpired)
      return;
    if (!openAttemptRef.current) {
      openAttemptRef.current = {
        operationKey: crypto.randomUUID(),
        title: `Terminal ${tabsRef.current.length + 1}`,
        running: false,
        scopeKey,
        taskId,
        workspaceId,
        createdAt: Date.now(),
      };
      try {
        sessionStorage.setItem(openStorageKey, JSON.stringify(openAttemptRef.current));
      } catch {
        // Keep the operation key in memory when storage is unavailable.
      }
    }
    setPendingOpen(true);
    void runOpen();
  }, [
    connected,
    openRecoveryExpired,
    openStorageKey,
    runOpen,
    scopeKey,
    shellUnavailable,
    taskId,
    terminalAvailable,
    transport,
    workspaceId,
  ]);

  useEffect(() => {
    if (openAttemptRef.current?.scopeKey === scopeKey) return;
    openAttemptRef.current = null;
    setPendingOpen(false);
    setOpenRecoveryExpired(false);
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(openStorageKey);
    } catch {
      return;
    }
    if (!raw) return;
    const attempt = parseStoredOpenAttempt(raw, { scopeKey, taskId, workspaceId });
    if (!attempt) {
      try {
        sessionStorage.removeItem(openStorageKey);
      } catch {
        // Storage may be unavailable in a restricted browser context.
      }
      return;
    }
    if (Date.now() - attempt.createdAt >= OPEN_RECEIPT_RETRY_WINDOW_MS) {
      setOpenRecoveryExpired(true);
      showError(
        "A previous terminal open may have completed, but its retry receipt expired. Check the terminal list before opening another.",
      );
      return;
    }
    openAttemptRef.current = attempt;
    setPendingOpen(true);
    void runOpen();
  }, [openStorageKey, runOpen, scopeKey, showError, taskId, workspaceId]);

  const dismissOpenRecovery = useCallback(() => {
    openAttemptRef.current = null;
    setOpenRecoveryExpired(false);
    setPendingOpen(false);
    setError("");
    try {
      sessionStorage.removeItem(openStorageKey);
    } catch {
      // Storage may be unavailable in a restricted browser context.
    }
  }, [openStorageKey]);

  const retry = useCallback(() => {
    setError("");
    setRefreshVersion((current) => current + 1);
    if (openAttemptRef.current) void runOpen();
  }, [runOpen]);

  closeRef.current = runClose;

  useEffect(() => {
    const effectScopeKey = scopeKey;
    const runId = scopeRunRef.current + 1;
    scopeRunRef.current = runId;
    const scope = { taskId, workspaceId };
    const targetTransport = transport;
    setError("");
    if (!terminalAvailable) setLoading(false);
    if (transport && connected && terminalAvailable) {
      void refreshTabs(runId);
      if (openAttemptRef.current) void runOpen();
    }
    return () => {
      scopeRunRef.current += 1;
      const scopeChanged = scopeKeyRef.current !== effectScopeKey;
      if (targetTransport) detachBestEffort(targetTransport, scope, scopeChanged);
      for (const tabId of replayTimersRef.current.keys()) clearReplayTimer(tabId);
      if (scopeChanged) {
        let hasQueuedInput = false;
        for (const queue of inputQueuesRef.current.values()) {
          if (queue.length) {
            hasQueuedInput = true;
            break;
          }
        }
        if (hasQueuedInput) {
          showError(
            "The selected task changed before terminal input was confirmed. Pending input was not sent to the new task.",
          );
        }
        attachAttemptsRef.current.clear();
        closeAttemptsRef.current.clear();
        inputQueuesRef.current.clear();
        inputQueueCharsRef.current.clear();
        resizeStatesRef.current.clear();
        cursorsRef.current.clear();
        const openAttempt = openAttemptRef.current;
        if (openAttempt && openAttempt.scopeKey !== scopeKeyRef.current) {
          openAttemptRef.current = null;
          setPendingOpen(false);
          setOpenRecoveryExpired(false);
        }
      }
    };
  }, [
    clearReplayTimer,
    connected,
    detachBestEffort,
    refreshTabs,
    runOpen,
    scopeKey,
    showError,
    taskId,
    terminalAvailable,
    transport,
    workspaceId,
    refreshVersion,
  ]);

  useEffect(() => {
    for (const tab of tabs) {
      const element = terminalElementsRef.current.get(tab.id);
      if (!element || terminalHandlesRef.current.has(tab.id)) continue;
      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: attachmentStates[tab.id]?.writer !== true,
        fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.35,
        scrollback: 10_000,
        theme: {
          background: "#111821",
          foreground: "#dbe4ee",
          cursor: "#dbe4ee",
          selectionBackground: "#36536e",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      const disposables = [
        terminal.onData((input) => inputRef.current(tab.id, input)),
        terminal.onResize(({ cols, rows }) => resizeRef.current(tab.id, { cols, rows })),
      ];
      terminal.open(element);
      terminalHandlesRef.current.set(tab.id, { terminal, fitAddon, disposables });
      const bufferedOutput = outputBufferRef.current.get(tab.id);
      if (bufferedOutput) {
        for (const text of bufferedOutput) terminal.write(text);
        outputBufferRef.current.delete(tab.id);
      }
      requestAnimationFrame(() => {
        if (tab.id !== activeTabId) return;
        try {
          fitAddon.fit();
          terminal.focus();
        } catch {
          // The element can still be hidden during a tab transition.
        }
      });
      if (attachmentsRef.current.has(tab.id)) scheduleReplayRef.current(tab.id, 0);
    }
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of terminalHandlesRef.current.keys()) {
      if (!liveIds.has(tabId)) disposeTerminal(tabId);
    }
  }, [activeTabId, attachmentStates, disposeTerminal, tabs]);

  useEffect(() => {
    for (const [tabId, handle] of terminalHandlesRef.current) {
      handle.terminal.options.disableStdin = attachmentStates[tabId]?.writer !== true;
    }
  }, [attachmentStates, connected, tabs]);

  useEffect(() => {
    const tabId = activeTab?.id;
    if (!tabId) return;
    const handle = terminalHandlesRef.current.get(tabId);
    if (!handle) return;
    requestAnimationFrame(() => {
      try {
        handle.fitAddon.fit();
        handle.terminal.focus();
      } catch {
        // FitAddon ignores terminals that are temporarily hidden.
      }
    });
    const element = terminalElementsRef.current.get(tabId)?.parentElement;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          handle.fitAddon.fit();
        } catch {
          return;
        }
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeTab?.id]);

  useEffect(() => {
    if (!connected) return;
    for (const tab of tabsRef.current) {
      const attachment = attachmentsRef.current.get(tab.id);
      if (attachment) {
        scheduleReplayRef.current(tab.id, 0);
        void flushInputRef.current(tab.id);
        void flushResizeRef.current(tab.id);
      }
    }
  }, [connected, transport]);

  useEffect(
    () => () => {
      for (const tabId of terminalHandlesRef.current.keys()) disposeTerminal(tabId);
      for (const timer of replayTimersRef.current.values()) clearTimeout(timer);
      replayTimersRef.current.clear();
    },
    [disposeTerminal],
  );

  if (!terminalAvailable) {
    return (
      <section className="web-terminal" aria-label="Workspace terminal">
        <div className="web-terminal-heading">
          <SquareTerminal size={17} aria-hidden="true" />
          <div>
            <p className="web-eyebrow">Workspace</p>
            <h3>Terminal</h3>
          </div>
        </div>
        <p className="web-terminal-message">
          {capability?.available === false ? capability.reason : "Terminal access is unavailable."}
        </p>
      </section>
    );
  }

  return (
    <section className="web-terminal" aria-label="Workspace terminal">
      <div className="web-terminal-heading">
        <div className="web-terminal-title">
          <SquareTerminal size={17} aria-hidden="true" />
          <div>
            <p className="web-eyebrow">Workspace</p>
            <h3>Terminal</h3>
          </div>
        </div>
        <div className="web-terminal-actions">
          {!connected && <span className="web-terminal-connection">Host disconnected</span>}
          <button
            className="web-terminal-icon-button"
            type="button"
            aria-label="Refresh terminal list"
            title="Refresh terminal list"
            disabled={!connected || loading}
            onClick={() => retry()}
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
          <button
            className="web-terminal-new-button"
            type="button"
            disabled={
              !connected ||
              pendingOpen ||
              loading ||
              shellUnavailable ||
              openRecoveryExpired ||
              tabs.length >= 12
            }
            onClick={openTerminal}
          >
            <Plus size={15} aria-hidden="true" />
            {pendingOpen ? "Opening…" : "New terminal"}
          </button>
        </div>
      </div>

      {error && (
        <div className="web-terminal-error" role="alert">
          <span>{error}</span>
          <button type="button" disabled={!connected} onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {shellUnavailable && (
        <p className="web-terminal-message" role="alert">
          Shell access is disabled for this task. Enable terminal access in CoWork, then refresh
          this panel.
        </p>
      )}

      {openRecoveryExpired && (
        <div className="web-terminal-error" role="alert">
          <span>
            A previous terminal open may have completed. Check the terminal list before continuing.
          </span>
          <button type="button" onClick={dismissOpenRecovery}>
            I checked the list
          </button>
        </div>
      )}

      {loading && tabs.length === 0 && (
        <div className="web-terminal-empty web-terminal-loading" aria-live="polite">
          <span className="web-terminal-loader" aria-hidden="true" />
          <span>Loading workspace terminals</span>
        </div>
      )}

      {!loading && tabs.length === 0 && !error && (
        <div className="web-terminal-empty">
          <span className="web-terminal-empty-icon">
            <SquareTerminal size={19} aria-hidden="true" />
          </span>
          <strong>No terminal sessions</strong>
          <span>Open a terminal to run commands in this workspace.</span>
        </div>
      )}

      {tabs.length > 0 && (
        <>
          <div className="web-terminal-tabs" role="tablist" aria-label="Terminal sessions">
            {tabs.map((tab, index) => {
              const selected = activeTab?.id === tab.id;
              const attachment = attachmentStates[tab.id];
              return (
                <div className={`web-terminal-tab${selected ? " is-active" : ""}`} key={tab.id}>
                  <button
                    className="web-terminal-tab-select"
                    id={`web-terminal-tab-${safeDomId(tab.id)}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`web-terminal-panel-${safeDomId(tab.id)}`}
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    <span
                      className={`web-terminal-status web-terminal-status-${safeStatus(tab.status)}`}
                    />
                    <span>Terminal {index + 1}</span>
                    {!attachment?.writer && attachment && (
                      <span className="web-terminal-readonly">Read only</span>
                    )}
                  </button>
                  <button
                    className="web-terminal-tab-close"
                    type="button"
                    aria-label={`Close terminal ${index + 1}`}
                    title="Close terminal"
                    disabled={!connected || !attachment?.writer}
                    onClick={() => void runClose(tab.id)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {tabs.map((tab) => {
            const selected = activeTab?.id === tab.id;
            const attachment = attachmentStates[tab.id];
            return (
              <div
                className={`web-terminal-panel${selected ? " is-active" : ""}`}
                id={`web-terminal-panel-${safeDomId(tab.id)}`}
                role="tabpanel"
                aria-labelledby={`web-terminal-tab-${safeDomId(tab.id)}`}
                key={tab.id}
                hidden={!selected}
                onMouseDown={() => terminalHandlesRef.current.get(tab.id)?.terminal.focus()}
              >
                <div
                  className="web-terminal-screen"
                  ref={(element) => {
                    if (element) terminalElementsRef.current.set(tab.id, element);
                    else terminalElementsRef.current.delete(tab.id);
                  }}
                />
                <div className="web-terminal-footer">
                  <span>
                    {attachment
                      ? attachment.writer
                        ? "Input enabled"
                        : "Another browser controls input"
                      : "Attaching…"}
                  </span>
                  <span>{connected ? "Live output" : "Waiting for host connection"}</span>
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

function parseTerminalList(value: unknown, taskId: string, workspaceId: string): TerminalTab[] {
  if (
    !isRecord(value) ||
    value.taskId !== taskId ||
    value.workspaceId !== workspaceId ||
    !Array.isArray(value.tabs)
  ) {
    throw new Error("The host returned an invalid terminal list.");
  }
  return value.tabs.map((tab) => {
    if (
      !isRecord(tab) ||
      typeof tab.id !== "string" ||
      typeof tab.status !== "string" ||
      !Number.isSafeInteger(tab.createdAt) ||
      !Number.isSafeInteger(tab.updatedAt)
    ) {
      throw new Error("The host returned invalid terminal metadata.");
    }
    return tab as TerminalTab;
  });
}

function parseAttachResult(value: unknown, expectedTabId?: string): AttachResult {
  if (
    !isRecord(value) ||
    typeof value.attachmentId !== "string" ||
    !value.attachmentId ||
    typeof value.writer !== "boolean" ||
    !Number.isSafeInteger(value.nextOffset) ||
    !isRecord(value.tab) ||
    typeof value.tab.id !== "string" ||
    (expectedTabId !== undefined && value.tab.id !== expectedTabId) ||
    typeof value.tab.status !== "string" ||
    !Number.isSafeInteger(value.tab.createdAt) ||
    !Number.isSafeInteger(value.tab.updatedAt)
  ) {
    throw new Error("The host returned an invalid terminal attachment.");
  }
  const gap = parseGap(value.gap);
  return {
    attachmentId: value.attachmentId,
    writer: value.writer,
    tab: value.tab as TerminalTab,
    nextOffset: value.nextOffset as number,
    ...(gap ? { gap } : {}),
  };
}

function parseReplayPage(value: unknown): ReplayPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.chunks) ||
    !Number.isSafeInteger(value.nextOffset) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("The host returned invalid terminal output.");
  }
  const chunks = value.chunks.map((chunk) => {
    if (!isRecord(chunk) || !Number.isSafeInteger(chunk.offset) || typeof chunk.text !== "string") {
      throw new Error("The host returned invalid terminal output.");
    }
    return { offset: chunk.offset as number, text: chunk.text };
  });
  const gap = parseGap(value.gap);
  return {
    chunks,
    nextOffset: value.nextOffset as number,
    hasMore: value.hasMore,
    ...(gap ? { gap } : {}),
  };
}

function parseGap(value: unknown): OutputGap | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.from) ||
    !Number.isSafeInteger(value.to) ||
    Number(value.from) < 0 ||
    Number(value.to) < Number(value.from)
  ) {
    throw new Error("The host returned an invalid terminal output gap.");
  }
  return { from: value.from as number, to: value.to as number };
}

function parseStoredOpenAttempt(
  value: string,
  scope: { scopeKey: string; taskId: string; workspaceId: string },
): OpenAttempt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.operationKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(parsed.operationKey) ||
    typeof parsed.title !== "string" ||
    parsed.title.length > 80 ||
    !Number.isFinite(parsed.createdAt) ||
    parsed.taskId !== scope.taskId ||
    parsed.workspaceId !== scope.workspaceId ||
    parsed.scopeKey !== scope.scopeKey
  ) {
    return null;
  }
  return {
    operationKey: parsed.operationKey,
    title: parsed.title,
    running: false,
    scopeKey: scope.scopeKey,
    taskId: scope.taskId,
    workspaceId: scope.workspaceId,
    createdAt: parsed.createdAt as number,
  };
}

function isRetryableMutationFailure(cause: unknown): boolean {
  if (!(cause instanceof WebTransportError)) return true;
  return cause.retryable || cause.code === "OUTCOME_UNKNOWN";
}

function splitInput(input: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < input.length) {
    let end = Math.min(input.length, offset + maxLength);
    if (
      end < input.length &&
      isHighSurrogate(input.charCodeAt(end - 1)) &&
      isLowSurrogate(input.charCodeAt(end))
    ) {
      end -= 1;
    }
    if (end === offset) end = Math.min(input.length, offset + maxLength + 1);
    chunks.push(input.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function safeStatus(value: string): string {
  return /^[a-z-]+$/.test(value) ? value : "unknown";
}

function safeDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof WebTransportError && cause.code === "OUTCOME_UNKNOWN") {
    return `${cause.message} Retry will reconcile the same operation safely.`;
  }
  return cause instanceof Error ? cause.message : fallback;
}
