import { createHash, randomBytes, randomUUID } from "crypto";
import type { ShellSessionInfo, Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { normalizeTerminalAttachInput } from "../../electron/terminal/terminal-input-policy";
import type { TerminalPtyManager } from "../../electron/terminal/TerminalPtyManager";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

const MAX_TERMINAL_TABS = 12;
const MAX_ATTACHMENTS = 128;
const MAX_OUTPUT_STATES = 64;
const MAX_OUTPUT_CHARS_PER_TAB = 256 * 1024;
const MAX_OUTPUT_CHARS_TOTAL = 2 * 1024 * 1024;
const MAX_OUTPUT_SEGMENTS_PER_TAB = 2_048;
const MAX_OUTPUT_SEGMENTS_TOTAL = 16_384;
const DEFAULT_REPLAY_LIMIT = 16 * 1024;
const MAX_REPLAY_LIMIT = 16 * 1024;
const MAX_INPUT_CHARS = 16 * 1024;
const MAX_COLUMNS = 500;
const MAX_ROWS = 300;
const ATTACHMENT_LEASE_MS = 2 * 60_000;
const DETACHED_STATE_TTL_MS = 10 * 60_000;
const MAX_OPERATION_RECEIPTS = 2_000;
const OPERATION_RECEIPT_TTL_MS = 10 * 60_000;
const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

type OutputListener = Parameters<TerminalPtyManager["attachTerminalTabOutput"]>[2];

interface OutputSegment {
  offset: number;
  text: string;
  touchedAt: number;
  stream: "stdout";
  cwd: string;
  status: ShellSessionInfo["status"];
}

interface BrowserTerminalAttachment {
  id: string;
  audience: string;
  installationId: string;
  profileId: string;
  generation: string;
  sessionId: string;
  workspaceId: string;
  taskId: string;
  tabId: string;
  expiresAt: number;
}

interface BrowserTerminalTabOwner {
  workspaceId: string;
  taskId: string;
}

interface TerminalOutputState {
  key: string;
  listenerKey: string;
  workspaceId: string;
  tabId: string;
  segments: OutputSegment[];
  retainedChars: number;
  nextOffset: number;
  attachments: Map<string, BrowserTerminalAttachment>;
  writerAttachmentId: string | null;
  listenerAttached: boolean;
  closed: boolean;
  createdAt: number;
  lastTouchedAt: number;
}

interface TerminalScopeRequest {
  workspaceId: string;
  taskId: string;
}

interface TerminalAttachmentRequest extends TerminalScopeRequest {
  attachmentId: string;
}

interface TerminalWorkspaceSources {
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  getTask(taskId: string): Promise<Task | null>;
  /** Must apply the same effective shell policy used by the desktop terminal. */
  assertShellAllowed(workspace: Workspace, task: Task): Promise<void> | void;
  terminal: Pick<
    TerminalPtyManager,
    | "createTab"
    | "listTabs"
    | "attachTerminalTabOutput"
    | "detachTerminalTabOutput"
    | "writeToTab"
    | "resizeTab"
    | "stopTab"
    | "closeTab"
  >;
  now?: () => number;
  createAttachmentId?: () => string;
}

interface OperationReceipt {
  fingerprint: string;
  expiresAt: number;
  promise?: Promise<unknown>;
  result?: unknown;
}

/**
 * Browser RPC adapter for already-created host PTYs. It never spawns a shell:
 * all tab identity and process operations remain owned by TerminalPtyManager.
 */
export function createBrowserTerminalMethods(
  sources: TerminalWorkspaceSources,
): Record<string, WebRpcMethod> {
  const service = new BrowserTerminalAttachmentService(sources);
  return service.methods();
}

export class BrowserTerminalAttachmentService {
  private readonly outputStates = new Map<string, TerminalOutputState>();
  private readonly attachments = new Map<string, TerminalOutputState>();
  private readonly operationReceipts = new Map<string, OperationReceipt>();
  private readonly tabOwners = new Map<string, BrowserTerminalTabOwner>();
  private readonly serviceId = randomBytes(12).toString("hex");
  private readonly now: () => number;
  private readonly createAttachmentId: () => string;
  private retainedOutputChars = 0;
  private retainedOutputSegments = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sources: TerminalWorkspaceSources) {
    this.now = sources.now ?? Date.now;
    this.createAttachmentId = sources.createAttachmentId ?? (() => randomUUID());
  }

  methods(): Record<string, WebRpcMethod> {
    return {
      "terminal.list": {
        capability: "terminal.attach",
        validateParams: parseScopeRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as TerminalScopeRequest;
          const { workspace, task } = await this.authorize(context, request, true);
          const workspaceTabs = this.sources.terminal.listTabs(workspace.id);
          this.pruneTabOwners(workspace.id, new Set(workspaceTabs.map((tab) => tab.id)));
          const tabs = workspaceTabs.filter((tab) =>
            this.hasTabOwner(tab.id, workspace.id, task.id),
          );
          return {
            workspaceId: workspace.id,
            taskId: request.taskId,
            tabs: tabs
              .slice(0, MAX_TERMINAL_TABS)
              .map((tab) => cloneScopedSessionInfo(tab, task.id)),
          };
        },
      },
      "terminal.attach": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseAttachRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as AttachRequest;
          const { workspace, task } = await this.authorize(context, request, true);
          this.requireTabOwner(request.tabId, workspace.id, task.id);
          this.findTab(workspace.id, request.tabId);
          return this.executeMutation(context, "terminal.attach", request, () =>
            this.attach(context, request),
          );
        },
      },
      "terminal.open": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseOpenRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as OpenRequest;
          await this.authorize(context, request, true);
          return this.executeMutation(context, "terminal.open", request, async () => {
            const { workspace } = await this.authorize(context, request, true);
            const tab = this.sources.terminal.createTab({
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              cwd: workspace.path,
              ...(request.title ? { title: request.title } : {}),
            });
            this.tabOwners.set(tab.id, { workspaceId: workspace.id, taskId: request.taskId });
            try {
              return await this.attach(context, { ...request, tabId: tab.id });
            } catch (error) {
              this.tabOwners.delete(tab.id);
              this.sources.terminal.closeTab(tab.id);
              throw error;
            }
          });
        },
      },
      "terminal.replay": {
        capability: "terminal.attach",
        validateParams: parseReplayRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as ReplayRequest;
          const state = await this.authorizeAttachment(context, request, true);
          return {
            ...this.readOutputPage(state, request.afterOffset, request.limit),
            tab: cloneScopedSessionInfo(
              this.findTab(request.workspaceId, state.tabId),
              request.taskId,
            ),
          };
        },
      },
      "terminal.input": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseInputRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as InputRequest;
          await this.authorize(context, request, true);
          return this.executeMutation(context, "terminal.input", request, () =>
            this.writeInput(context, request),
          );
        },
      },
      "terminal.resize": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseResizeRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as ResizeRequest;
          await this.authorize(context, request, true);
          return this.executeMutation(context, "terminal.resize", request, () =>
            this.resize(context, request),
          );
        },
      },
      "terminal.stop": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseAttachmentRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as TerminalAttachmentRequest;
          const state = await this.authorizeAttachment(context, request, true);
          this.requireWriter(context, request, state);
          return this.executeMutation(context, "terminal.stop", request, () =>
            this.stop(context, request),
          );
        },
      },
      "terminal.detach": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseAttachmentRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as TerminalAttachmentRequest;
          await this.authorize(context, request, false);
          return this.executeMutation(context, "terminal.detach", request, () =>
            this.detach(context, request),
          );
        },
      },
      "terminal.close": {
        capability: "terminal.attach",
        mutation: true,
        validateParams: parseAttachmentRequest,
        handler: async (context, rawParams) => {
          const request = rawParams as TerminalAttachmentRequest;
          await this.authorize(context, request, true);
          return this.executeMutation(context, "terminal.close", request, () =>
            this.close(context, request),
          );
        },
      },
    };
  }

  /** Release listeners if the owning browser host is shutting down. */
  revokeSession(sessionId: string): void {
    for (const state of this.outputStates.values()) {
      for (const attachment of state.attachments.values()) {
        if (attachment.sessionId === sessionId) this.removeAttachment(state, attachment.id);
      }
    }
    for (const key of this.operationReceipts.keys()) {
      const scope = JSON.parse(key) as [string, string, string];
      if (scope[1] === sessionId) this.operationReceipts.delete(key);
    }
  }

  dispose(): void {
    for (const state of this.outputStates.values()) this.detachOutputListener(state);
    this.outputStates.clear();
    this.attachments.clear();
    this.operationReceipts.clear();
    this.tabOwners.clear();
    this.retainedOutputChars = 0;
    this.retainedOutputSegments = 0;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private async attach(context: WebRequestContext, request: AttachRequest): Promise<AttachResult> {
    const { workspace, task } = await this.authorize(context, request, true);
    this.requireTabOwner(request.tabId, workspace.id, task.id);
    const tab = this.findTab(workspace.id, request.tabId);
    const state = this.getOutputState(workspace.id, tab.id);
    this.startCleanupTimer();
    this.pruneAttachments(state);

    let attachment = this.findExistingAttachment(context, request, state);
    if (!attachment) {
      if (this.attachments.size >= MAX_ATTACHMENTS) {
        throw rateLimited("Too many active browser terminal attachments.");
      }
      const now = this.now();
      attachment = {
        id: this.createAttachmentId(),
        audience: context.audience,
        installationId: context.identity.installationId,
        profileId: context.identity.profileId,
        generation: context.identity.generation,
        sessionId: context.sessionId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        tabId: tab.id,
        expiresAt: now + ATTACHMENT_LEASE_MS,
      };
      state.attachments.set(attachment.id, attachment);
      this.attachments.set(attachment.id, state);
      if (!state.writerAttachmentId) state.writerAttachmentId = attachment.id;
    } else {
      attachment.expiresAt = this.now() + ATTACHMENT_LEASE_MS;
    }

    this.attachOutputListener(state);
    await flushMicrotask();
    this.pruneOutputStates();
    const gap = this.outputGap(state, 0);
    return {
      attachmentId: attachment.id,
      writer: state.writerAttachmentId === attachment.id,
      tab: cloneScopedSessionInfo(this.findTab(workspace.id, tab.id), task.id),
      nextOffset: state.nextOffset,
      ...(gap ? { gap } : {}),
    };
  }

  private async writeInput(
    context: WebRequestContext,
    request: InputRequest,
  ): Promise<{ accepted: true; nextOffset: number; tab: ScopedShellSessionInfo }> {
    const state = await this.authorizeAttachment(context, request, true);
    const attachment = this.requireWriter(context, request, state);
    attachment.expiresAt = this.now() + ATTACHMENT_LEASE_MS;
    const input = normalizeTerminalAttachInput(request.input);
    const tab = input
      ? this.sources.terminal.writeToTab(attachment.tabId, input)
      : this.findTab(request.workspaceId, attachment.tabId);
    state.lastTouchedAt = this.now();
    return {
      accepted: true,
      nextOffset: state.nextOffset,
      tab: cloneScopedSessionInfo(tab, request.taskId),
    };
  }

  private async resize(
    context: WebRequestContext,
    request: ResizeRequest,
  ): Promise<{ cols: number; rows: number; tab: ScopedShellSessionInfo }> {
    const state = await this.authorizeAttachment(context, request, true);
    const attachment = this.requireWriter(context, request, state);
    attachment.expiresAt = this.now() + ATTACHMENT_LEASE_MS;
    const cols = Math.min(MAX_COLUMNS, Math.max(2, request.cols));
    const rows = Math.min(MAX_ROWS, Math.max(1, request.rows));
    const tab = this.sources.terminal.resizeTab(attachment.tabId, cols, rows);
    state.lastTouchedAt = this.now();
    return { cols, rows, tab: cloneScopedSessionInfo(tab, request.taskId) };
  }

  private async stop(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
  ): Promise<ScopedShellSessionInfo | null> {
    const state = await this.authorizeAttachment(context, request, true);
    const attachment = this.requireWriter(context, request, state);
    const tab = this.sources.terminal.stopTab(attachment.tabId);
    state.lastTouchedAt = this.now();
    return tab ? cloneScopedSessionInfo(tab, request.taskId) : null;
  }

  private async detach(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
  ): Promise<{ detached: true }> {
    const state = this.requireAttachment(context, request);
    this.removeAttachment(state, request.attachmentId);
    state.lastTouchedAt = this.now();
    return { detached: true };
  }

  private async close(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
  ): Promise<{ closed: true }> {
    const state = await this.authorizeAttachment(context, request, true);
    const attachment = this.requireWriter(context, request, state);
    this.sources.terminal.closeTab(attachment.tabId);
    state.closed = true;
    for (const attachmentId of state.attachments.keys()) {
      this.attachments.delete(attachmentId);
    }
    state.attachments.clear();
    state.writerAttachmentId = null;
    this.detachOutputListener(state);
    state.lastTouchedAt = this.now();
    this.tabOwners.delete(attachment.tabId);
    return { closed: true };
  }

  private async authorizeAttachment(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
    requireShell: boolean,
  ): Promise<TerminalOutputState> {
    const state = this.requireAttachment(context, request);
    const attachment = state.attachments.get(request.attachmentId)!;
    if (requireShell) {
      const { workspace } = await this.authorize(context, request, true);
      this.findTab(workspace.id, attachment.tabId);
    } else {
      await this.authorize(context, request, false);
    }
    this.pruneAttachments(state);
    if (state.attachments.get(request.attachmentId) !== attachment) throw staleAttachment();
    attachment.expiresAt = this.now() + ATTACHMENT_LEASE_MS;
    state.lastTouchedAt = this.now();
    return state;
  }

  private async authorize(
    context: WebRequestContext,
    request: TerminalScopeRequest,
    requireShell: boolean,
  ): Promise<{ workspace: Workspace; task: Task }> {
    this.requireSession(context);
    const workspace = await this.sources.getWorkspace(request.workspaceId);
    const task = await this.sources.getTask(request.taskId);
    if (
      !workspace ||
      workspace.isTemp === true ||
      isTempWorkspaceId(workspace.id) ||
      !task ||
      task.workspaceId !== workspace.id
    ) {
      throw forbidden();
    }
    if (requireShell) {
      try {
        await this.sources.assertShellAllowed(workspace, task);
      } catch {
        throw forbidden("Terminal shell access is unavailable for this task.");
      }
    }
    return { workspace, task };
  }

  private requireAttachment(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
  ): TerminalOutputState {
    this.requireSession(context);
    this.pruneExpiredState();
    const state = this.attachments.get(request.attachmentId);
    const attachment = state?.attachments.get(request.attachmentId);
    if (
      !state ||
      !attachment ||
      attachment.audience !== context.audience ||
      attachment.installationId !== context.identity.installationId ||
      attachment.profileId !== context.identity.profileId ||
      attachment.generation !== context.identity.generation ||
      attachment.sessionId !== context.sessionId ||
      attachment.workspaceId !== request.workspaceId ||
      attachment.taskId !== request.taskId ||
      attachment.tabId !== state.tabId
    ) {
      throw forbidden("This terminal attachment is unavailable.");
    }
    this.pruneAttachments(state);
    if (!state.attachments.has(request.attachmentId)) {
      throw staleAttachment();
    }
    return state;
  }

  private requireWriter(
    context: WebRequestContext,
    request: TerminalAttachmentRequest,
    state: TerminalOutputState,
  ): BrowserTerminalAttachment {
    const attachment = state.attachments.get(request.attachmentId);
    if (!attachment || !this.isWriter(state, request.attachmentId)) {
      throw new WebApplicationError(
        "CONFLICT",
        "Another browser attachment owns this terminal's input.",
        409,
      );
    }
    if (
      attachment.sessionId !== context.sessionId ||
      attachment.workspaceId !== request.workspaceId ||
      attachment.taskId !== request.taskId
    ) {
      throw forbidden("This terminal attachment is unavailable.");
    }
    return attachment;
  }

  private findTab(workspaceId: string, tabId: string): ShellSessionInfo {
    const tab = this.sources.terminal
      .listTabs(workspaceId)
      .find((candidate) => candidate.id === tabId);
    if (!tab || tab.workspaceId !== workspaceId) throw forbidden();
    return tab;
  }

  private hasTabOwner(tabId: string, workspaceId: string, taskId: string): boolean {
    const owner = this.tabOwners.get(tabId);
    return owner?.workspaceId === workspaceId && owner.taskId === taskId;
  }

  private requireTabOwner(tabId: string, workspaceId: string, taskId: string): void {
    if (!this.hasTabOwner(tabId, workspaceId, taskId)) throw forbidden();
  }

  private pruneTabOwners(workspaceId: string, liveTabIds: Set<string>): void {
    for (const [tabId, owner] of this.tabOwners) {
      if (owner.workspaceId === workspaceId && !liveTabIds.has(tabId)) this.tabOwners.delete(tabId);
    }
  }

  private findExistingAttachment(
    context: WebRequestContext,
    request: AttachRequest,
    state: TerminalOutputState,
  ): BrowserTerminalAttachment | undefined {
    return [...state.attachments.values()].find(
      (attachment) =>
        attachment.audience === context.audience &&
        attachment.installationId === context.identity.installationId &&
        attachment.profileId === context.identity.profileId &&
        attachment.generation === context.identity.generation &&
        attachment.sessionId === context.sessionId &&
        attachment.workspaceId === request.workspaceId &&
        attachment.taskId === request.taskId &&
        attachment.tabId === request.tabId,
    );
  }

  private getOutputState(workspaceId: string, tabId: string): TerminalOutputState {
    this.pruneExpiredState();
    const key = JSON.stringify([workspaceId, tabId]);
    const existing = this.outputStates.get(key);
    if (existing) {
      existing.lastTouchedAt = this.now();
      return existing;
    }
    while (this.outputStates.size >= MAX_OUTPUT_STATES) {
      const evictable = [...this.outputStates.values()]
        .filter((state) => state.attachments.size === 0)
        .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)[0];
      if (!evictable) throw rateLimited("Too many active browser terminal tabs.");
      this.removeOutputState(evictable);
    }
    const now = this.now();
    const state: TerminalOutputState = {
      key,
      listenerKey: `browser-terminal:${this.serviceId}:${randomBytes(8).toString("hex")}`,
      workspaceId,
      tabId,
      segments: [],
      retainedChars: 0,
      nextOffset: 0,
      attachments: new Map(),
      writerAttachmentId: null,
      listenerAttached: false,
      closed: false,
      createdAt: now,
      lastTouchedAt: now,
    };
    this.outputStates.set(key, state);
    return state;
  }

  private attachOutputListener(state: TerminalOutputState): void {
    if (state.listenerAttached || state.closed) return;
    const listener: OutputListener = (event) => {
      if (this.outputStates.get(state.key) !== state || state.closed) return;
      if (
        !Number.isSafeInteger(event.offset) ||
        !Number.isSafeInteger(event.nextOffset) ||
        event.offset < 0 ||
        event.nextOffset !== event.offset + event.output.length
      ) {
        return;
      }
      this.appendOutput(state, event.offset, event.output, event.nextOffset, {
        stream: event.stream,
        cwd: event.cwd,
        status: event.status,
      });
    };
    this.sources.terminal.attachTerminalTabOutput(state.tabId, state.listenerKey, listener);
    state.listenerAttached = true;
  }

  private detachOutputListener(state: TerminalOutputState): void {
    if (!state.listenerAttached) return;
    this.sources.terminal.detachTerminalTabOutput(state.tabId, state.listenerKey);
    state.listenerAttached = false;
  }

  private appendOutput(
    state: TerminalOutputState,
    offset: number,
    output: string,
    nextOffset: number,
    metadata: Pick<OutputSegment, "stream" | "cwd" | "status">,
  ): void {
    const now = this.now();
    if (output) {
      let uncovered: OutputSegment[] = [{ offset, text: output, touchedAt: now, ...metadata }];
      for (const existing of state.segments) {
        uncovered = uncovered.flatMap((segment) => subtractSegment(segment, existing));
        if (!uncovered.length) break;
      }
      state.segments.push(...uncovered);
      state.segments.sort((a, b) => a.offset - b.offset);
      const addedChars = uncovered.reduce((total, segment) => total + segment.text.length, 0);
      state.retainedChars += addedChars;
      this.retainedOutputChars += addedChars;
      this.retainedOutputSegments += uncovered.length;
      this.mergeAdjacentSegments(state);
      this.trimState(state, MAX_OUTPUT_CHARS_PER_TAB);
      this.trimGlobalOutput();
    }
    state.nextOffset = Math.max(state.nextOffset, nextOffset);
    state.lastTouchedAt = now;
  }

  private mergeAdjacentSegments(state: TerminalOutputState): void {
    const merged: OutputSegment[] = [];
    for (const segment of state.segments) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.offset + previous.text.length === segment.offset &&
        previous.stream === segment.stream &&
        previous.cwd === segment.cwd &&
        previous.status === segment.status
      ) {
        previous.text += segment.text;
        previous.touchedAt = Math.max(previous.touchedAt, segment.touchedAt);
        this.retainedOutputSegments -= 1;
      } else {
        merged.push(segment);
      }
    }
    state.segments = merged;
  }

  private trimState(state: TerminalOutputState, maxChars: number): void {
    while (
      (state.retainedChars > maxChars || state.segments.length > MAX_OUTPUT_SEGMENTS_PER_TAB) &&
      state.segments.length
    ) {
      const excess = Math.max(0, state.retainedChars - maxChars);
      const oldest = state.segments[0]!;
      const drop = excess
        ? safeUtf16DropBoundary(oldest.text, Math.min(excess, oldest.text.length))
        : oldest.text.length;
      const removed = oldest.text.slice(0, drop).length;
      if (!removed) return;
      if (drop === oldest.text.length) {
        state.segments.shift();
        this.retainedOutputSegments -= 1;
      } else {
        oldest.offset += drop;
        oldest.text = oldest.text.slice(drop);
      }
      oldest.touchedAt = this.now();
      state.retainedChars -= removed;
      this.retainedOutputChars -= removed;
    }
  }

  private trimGlobalOutput(): void {
    while (
      this.retainedOutputChars > MAX_OUTPUT_CHARS_TOTAL ||
      this.retainedOutputSegments > MAX_OUTPUT_SEGMENTS_TOTAL
    ) {
      const oldestState = [...this.outputStates.values()]
        .filter((state) => state.segments.length > 0)
        .sort((a, b) => a.segments[0]!.touchedAt - b.segments[0]!.touchedAt)[0];
      if (!oldestState) return;
      const excess = Math.max(0, this.retainedOutputChars - MAX_OUTPUT_CHARS_TOTAL);
      const targetChars = Math.max(0, oldestState.retainedChars - excess);
      this.trimState(oldestState, Math.min(targetChars, MAX_OUTPUT_CHARS_PER_TAB));
      if (this.retainedOutputSegments > MAX_OUTPUT_SEGMENTS_TOTAL) {
        const oldest = oldestState.segments[0];
        if (oldest)
          this.trimState(oldestState, Math.max(0, oldestState.retainedChars - oldest.text.length));
      }
    }
  }

  private readOutputPage(
    state: TerminalOutputState,
    requestedOffset: number,
    limit: number,
  ): ReplayResult {
    if (requestedOffset > state.nextOffset) {
      throw invalidRequest("The terminal replay cursor is ahead of current output.");
    }
    let cursor = requestedOffset;
    const chunks: ReplayResult["chunks"] = [];
    let gap = this.outputGap(state, cursor);
    if (gap) cursor = gap.to;

    let remaining = limit;
    for (const segment of state.segments) {
      const segmentEnd = segment.offset + segment.text.length;
      if (segmentEnd <= cursor) continue;
      if (segment.offset > cursor) {
        gap ??= { from: cursor, to: segment.offset };
        cursor = segment.offset;
      }
      if (remaining <= 0) break;
      const start = Math.max(cursor, segment.offset);
      const from = start - segment.offset;
      const available = segment.text.length - from;
      const take = safeUtf16Cut(segment.text.slice(from), Math.min(available, remaining));
      if (take <= 0) break;
      const text = segment.text.slice(from, from + take);
      chunks.push({
        offset: start,
        text,
        stream: segment.stream,
        cwd: segment.cwd,
        status: segment.status,
      });
      cursor = start + text.length;
      remaining -= text.length;
    }

    return {
      chunks,
      nextOffset: cursor,
      hasMore: this.outputGap(state, cursor) !== null || cursor < state.nextOffset,
      ...(gap ? { gap } : {}),
    };
  }

  private outputGap(
    state: TerminalOutputState,
    offset: number,
  ): { from: number; to: number } | null {
    if (offset >= state.nextOffset) return null;
    const nextSegment = state.segments.find(
      (segment) => segment.offset + segment.text.length > offset,
    );
    if (!nextSegment) return { from: offset, to: state.nextOffset };
    if (offset < nextSegment.offset) return { from: offset, to: nextSegment.offset };
    const previousEnd = state.segments
      .filter((segment) => segment.offset <= offset)
      .reduce((end, segment) => Math.max(end, segment.offset + segment.text.length), 0);
    const following = state.segments.find((segment) => segment.offset > previousEnd);
    return following ? { from: previousEnd, to: following.offset } : null;
  }

  private isWriter(state: TerminalOutputState, attachmentId: string): boolean {
    return state.writerAttachmentId === attachmentId;
  }

  private pruneAttachments(state: TerminalOutputState): void {
    const now = this.now();
    let writerExpired = false;
    for (const [id, attachment] of state.attachments) {
      if (attachment.expiresAt > now) continue;
      state.attachments.delete(id);
      this.attachments.delete(id);
      if (state.writerAttachmentId === id) writerExpired = true;
    }
    if (writerExpired) this.promoteWriter(state);
    if (state.attachments.size === 0) this.detachOutputListener(state);
  }

  private promoteWriter(state: TerminalOutputState): void {
    state.writerAttachmentId =
      [...state.attachments.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0]?.id ?? null;
  }

  private removeAttachment(state: TerminalOutputState, attachmentId: string): void {
    state.attachments.delete(attachmentId);
    this.attachments.delete(attachmentId);
    if (state.writerAttachmentId === attachmentId) this.promoteWriter(state);
    if (state.attachments.size === 0) this.detachOutputListener(state);
  }

  private pruneExpiredState(): void {
    const now = this.now();
    for (const state of this.outputStates.values()) this.pruneAttachments(state);
    for (const state of this.outputStates.values()) {
      if (state.attachments.size === 0 && now - state.lastTouchedAt >= DETACHED_STATE_TTL_MS) {
        this.removeOutputState(state);
      }
    }
    this.pruneReceipts();
    if (this.outputStates.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.pruneExpiredState(), 30_000);
    this.cleanupTimer.unref?.();
  }

  private pruneOutputStates(): void {
    this.pruneExpiredState();
  }

  private removeOutputState(state: TerminalOutputState): void {
    this.detachOutputListener(state);
    this.outputStates.delete(state.key);
    for (const id of state.attachments.keys()) {
      state.attachments.delete(id);
      this.attachments.delete(id);
    }
    state.writerAttachmentId = null;
    this.retainedOutputChars -= state.retainedChars;
    this.retainedOutputSegments -= state.segments.length;
    state.retainedChars = 0;
    state.segments = [];
  }

  private requireSession(context: WebRequestContext): void {
    if (!context.sessionId.trim() || !context.identity.profileId.trim()) throw forbidden();
  }

  private async executeMutation<T>(
    context: WebRequestContext,
    method: string,
    params: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    this.requireSession(context);
    const operationKey = context.operationKey;
    if (!operationKey || !OPERATION_KEY_RE.test(operationKey)) {
      throw invalidRequest("A stable terminal operation key is required.");
    }
    this.pruneReceipts();
    const receiptKey = JSON.stringify([context.audience, context.sessionId, operationKey]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method, params }))
      .digest("hex");
    const existing = this.operationReceipts.get(receiptKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new WebApplicationError(
          "CONFLICT",
          "This terminal operation key was already used for another action.",
          409,
        );
      }
      if (existing.promise) return (await existing.promise) as T;
      return existing.result as T;
    }
    if (this.operationReceipts.size >= MAX_OPERATION_RECEIPTS) {
      throw rateLimited("Too many pending terminal operations.");
    }
    const receipt: OperationReceipt = {
      fingerprint,
      expiresAt: this.now() + OPERATION_RECEIPT_TTL_MS,
    };
    const promise = action();
    receipt.promise = promise;
    this.operationReceipts.set(receiptKey, receipt);
    try {
      const result = await promise;
      receipt.result = result;
      receipt.promise = undefined;
      receipt.expiresAt = this.now() + OPERATION_RECEIPT_TTL_MS;
      return result;
    } catch (error) {
      this.operationReceipts.delete(receiptKey);
      throw error;
    }
  }

  private pruneReceipts(): void {
    const now = this.now();
    for (const [key, receipt] of this.operationReceipts) {
      if (!receipt.promise && receipt.expiresAt <= now) this.operationReceipts.delete(key);
    }
  }
}

interface AttachRequest extends TerminalScopeRequest {
  tabId: string;
}

interface OpenRequest extends TerminalScopeRequest {
  title?: string;
}

interface ReplayRequest extends TerminalAttachmentRequest {
  afterOffset: number;
  limit: number;
}

interface InputRequest extends TerminalAttachmentRequest {
  input: string;
}

interface ResizeRequest extends TerminalAttachmentRequest {
  cols: number;
  rows: number;
}

interface AttachResult {
  attachmentId: string;
  writer: boolean;
  tab: ScopedShellSessionInfo;
  nextOffset: number;
  gap?: { from: number; to: number };
}

interface ReplayResult {
  chunks: Array<{
    offset: number;
    text: string;
    stream: "stdout";
    cwd: string;
    status: ShellSessionInfo["status"];
  }>;
  nextOffset: number;
  hasMore: boolean;
  gap?: { from: number; to: number };
}

type ScopedShellSessionInfo = ShellSessionInfo & { scopeTaskId: string };

function parseScopeRequest(value: unknown): TerminalScopeRequest {
  if (!isRecord(value)) throw invalidRequest();
  return { workspaceId: parseId(value.workspaceId), taskId: parseId(value.taskId) };
}

function parseAttachRequest(value: unknown): AttachRequest {
  const scope = parseScopeRequest(value);
  if (!isRecord(value)) throw invalidRequest();
  return { ...scope, tabId: parseId(value.tabId) };
}

function parseOpenRequest(value: unknown): OpenRequest {
  const scope = parseScopeRequest(value);
  if (!isRecord(value)) throw invalidRequest();
  if (Object.prototype.hasOwnProperty.call(value, "cwd")) {
    throw invalidRequest("Browser terminals always start at the workspace root.");
  }
  if (value.title === undefined) return scope;
  if (typeof value.title !== "string" || value.title.trim().length > 80) {
    throw invalidRequest("Terminal title must be 80 characters or fewer.");
  }
  const title = value.title.trim();
  return title ? { ...scope, title } : scope;
}

function parseAttachmentRequest(value: unknown): TerminalAttachmentRequest {
  const scope = parseScopeRequest(value);
  if (!isRecord(value)) throw invalidRequest();
  return { ...scope, attachmentId: parseId(value.attachmentId) };
}

function parseReplayRequest(value: unknown): ReplayRequest {
  const attachment = parseAttachmentRequest(value);
  if (!isRecord(value)) throw invalidRequest();
  const limit = value.limit === undefined ? DEFAULT_REPLAY_LIMIT : value.limit;
  if (
    !isSafeIntegerAtLeast(value.afterOffset, 0) ||
    !isSafeIntegerAtLeast(limit, 1) ||
    Number(limit) > MAX_REPLAY_LIMIT
  ) {
    throw invalidRequest();
  }
  return { ...attachment, afterOffset: Number(value.afterOffset), limit: Number(limit) };
}

function parseInputRequest(value: unknown): InputRequest {
  const attachment = parseAttachmentRequest(value);
  if (!isRecord(value) || typeof value.input !== "string" || value.input.length > MAX_INPUT_CHARS) {
    throw invalidRequest("Terminal input must be a bounded string.");
  }
  return { ...attachment, input: value.input };
}

function parseResizeRequest(value: unknown): ResizeRequest {
  const attachment = parseAttachmentRequest(value);
  if (
    !isRecord(value) ||
    !isSafeIntegerAtLeast(value.cols, 2) ||
    !isSafeIntegerAtLeast(value.rows, 1)
  ) {
    throw invalidRequest("Terminal dimensions are invalid.");
  }
  return { ...attachment, cols: Number(value.cols), rows: Number(value.rows) };
}

function parseId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 256) throw invalidRequest();
  return id;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function cloneShellSessionInfo(tab: ShellSessionInfo): ShellSessionInfo {
  return {
    ...tab,
    aliases: [...tab.aliases],
    envKeys: [...tab.envKeys],
  };
}

function cloneScopedSessionInfo(
  tab: ShellSessionInfo,
  scopeTaskId: string,
): ScopedShellSessionInfo {
  return { ...cloneShellSessionInfo(tab), scopeTaskId };
}

function subtractSegment(source: OutputSegment, existing: OutputSegment): OutputSegment[] {
  const sourceEnd = source.offset + source.text.length;
  const existingEnd = existing.offset + existing.text.length;
  if (existingEnd <= source.offset || existing.offset >= sourceEnd) return [source];
  const remaining: OutputSegment[] = [];
  if (existing.offset > source.offset) {
    const prefixEnd = Math.min(existing.offset, sourceEnd);
    remaining.push({
      offset: source.offset,
      text: source.text.slice(0, prefixEnd - source.offset),
      touchedAt: source.touchedAt,
      stream: source.stream,
      cwd: source.cwd,
      status: source.status,
    });
  }
  if (existingEnd < sourceEnd) {
    const suffixStart = Math.max(existingEnd, source.offset);
    remaining.push({
      offset: suffixStart,
      text: source.text.slice(suffixStart - source.offset),
      touchedAt: source.touchedAt,
      stream: source.stream,
      cwd: source.cwd,
      status: source.status,
    });
  }
  return remaining.filter((segment) => segment.text.length > 0);
}

/** Keep cuts on Unicode scalar boundaries while offsets still count UTF-16 units. */
function safeUtf16Cut(value: string, requestedUnits: number): number {
  let cut = Math.max(0, Math.min(value.length, Math.floor(requestedUnits)));
  if (
    cut > 0 &&
    cut < value.length &&
    isHighSurrogate(value.charCodeAt(cut - 1)) &&
    isLowSurrogate(value.charCodeAt(cut))
  ) {
    cut -= 1;
  }
  return cut;
}

function safeUtf16DropBoundary(value: string, requestedUnits: number): number {
  let cut = Math.max(0, Math.min(value.length, Math.floor(requestedUnits)));
  if (
    cut > 0 &&
    cut < value.length &&
    isHighSurrogate(value.charCodeAt(cut - 1)) &&
    isLowSurrogate(value.charCodeAt(cut))
  ) {
    cut += 1;
  }
  return cut;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function flushMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function forbidden(message = "Terminal access is unavailable for this task."): WebApplicationError {
  return new WebApplicationError("FORBIDDEN", message, 403);
}

function staleAttachment(): WebApplicationError {
  return new WebApplicationError("STALE_STATE", "This terminal attachment has expired.", 409);
}

function invalidRequest(message = "Invalid browser terminal request."): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", message, 400);
}

function rateLimited(message: string): WebApplicationError {
  return new WebApplicationError("RATE_LIMITED", message, 429, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
