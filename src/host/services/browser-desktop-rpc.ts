import { createHash } from "node:crypto";
import type { HostCapabilityName } from "../../shared/host-api/contracts";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

export interface BrowserDesktopDefinition {
  capability?: HostCapabilityName;
  mutation?: boolean;
  minArgs?: number;
  maxArgs?: number;
  validate?: (args: unknown[]) => unknown[];
  handler: (args: unknown[], context: WebRequestContext) => unknown | Promise<unknown>;
}

export type BrowserDesktopDefinitions = Record<string, BrowserDesktopDefinition>;

type Receipt = {
  fingerprint: string;
  result: Promise<unknown>;
};

/** Closed method table: the request never chooses an IPC channel or host callback. */
export class BrowserDesktopRpcService {
  private readonly receipts = new Map<string, Map<string, Receipt>>();
  private receiptCount = 0;

  constructor(private readonly definitions: BrowserDesktopDefinitions) {}

  get methodNames(): string[] {
    return Object.keys(this.definitions).sort();
  }

  get manifest(): Record<string, { mutation: boolean }> {
    return Object.fromEntries(
      Object.entries(this.definitions).map(([name, definition]) => [
        name,
        { mutation: definition.mutation === true },
      ]),
    );
  }

  get capabilities(): Set<HostCapabilityName> {
    return new Set(
      Object.values(this.definitions).flatMap((definition) =>
        definition.capability ? [definition.capability] : [],
      ),
    );
  }

  methods(): Record<string, WebRpcMethod> {
    return Object.fromEntries(
      Object.entries(this.definitions).map(([name, definition]) => [
        `desktop.${name}`,
        {
          capability: definition.capability,
          mutation: definition.mutation,
          validateParams: (value: unknown) => this.parseArgs(definition, value),
          handler: (context: WebRequestContext, args: unknown) =>
            this.invoke(name, definition, context, args as unknown[]),
        } satisfies WebRpcMethod,
      ]),
    );
  }

  revokeSession(sessionId: string): void {
    for (const [key, receipts] of this.receipts) {
      if (!key.endsWith(`:${sessionId}`)) continue;
      this.receiptCount -= receipts.size;
      this.receipts.delete(key);
    }
  }

  dispose(): void {
    this.receipts.clear();
    this.receiptCount = 0;
  }

  private parseArgs(definition: BrowserDesktopDefinition, value: unknown): unknown[] {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "args" && key !== "omittedArgs")
    ) {
      throw new WebApplicationError("INVALID_REQUEST", "Invalid browser action arguments.");
    }
    const args = (value as { args?: unknown }).args;
    if (
      !Array.isArray(args) ||
      args.length < (definition.minArgs ?? 0) ||
      args.length > (definition.maxArgs ?? 4)
    ) {
      throw new WebApplicationError("INVALID_REQUEST", "Invalid browser action arguments.");
    }
    const omitted = (value as { omittedArgs?: unknown }).omittedArgs;
    if (
      omitted !== undefined &&
      (!Array.isArray(omitted) ||
        omitted.some(
          (index, position) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= args.length ||
            args[index] !== null ||
            omitted.indexOf(index) !== position,
        ))
    ) {
      throw new WebApplicationError("INVALID_REQUEST", "Invalid omitted browser arguments.");
    }
    const decoded = args.map((arg, index) =>
      Array.isArray(omitted) && omitted.includes(index) ? undefined : arg,
    );
    try {
      return definition.validate ? definition.validate(decoded) : decoded;
    } catch (error) {
      if (error instanceof WebApplicationError) throw error;
      throw new WebApplicationError("INVALID_REQUEST", "Invalid browser action arguments.");
    }
  }

  private async invoke(
    name: string,
    definition: BrowserDesktopDefinition,
    context: WebRequestContext,
    args: unknown[],
  ): Promise<unknown> {
    if (!definition.mutation) return (await definition.handler(args, context)) ?? null;
    if (!context.operationKey) {
      throw new WebApplicationError("INVALID_REQUEST", "An operation key is required.");
    }
    const scope = `${context.audience}:${context.sessionId}`;
    const key = `${name}:${context.operationKey}`;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          args,
          omittedArgs: args.flatMap((arg, index) => (arg === undefined ? [index] : [])),
        }),
      )
      .digest("hex");
    const sessionReceipts = this.receipts.get(scope) ?? new Map<string, Receipt>();
    const existing = sessionReceipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new WebApplicationError(
          "CONFLICT",
          "This action key was used for other content.",
          409,
        );
      }
      return existing.result;
    }
    // Never evict an uncertain receipt and later dispatch the same key again.
    // Host restart revokes the session; the browser keeps pending keys across
    // reauthentication and blocks replay into a new session.
    if (this.receiptCount >= 5_000) {
      throw new WebApplicationError("RATE_LIMITED", "Pair a new browser session to continue.", 429);
    }
    const result = Promise.resolve()
      .then(async () => (await definition.handler(args, context)) ?? null)
      .catch((error: unknown) => {
        if (error instanceof WebApplicationError) throw error;
        throw new WebApplicationError(
          "OUTCOME_UNKNOWN",
          "The host did not confirm this action. Check its current state before sending different content.",
          503,
        );
      });
    // The stored promise handles repeated concurrent requests as well as replies
    // lost during a connection interruption. Rejections remain cached too.
    sessionReceipts.set(key, { fingerprint, result });
    this.receipts.set(scope, sessionReceipts);
    this.receiptCount += 1;
    return result;
  }
}
