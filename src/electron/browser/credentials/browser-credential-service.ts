import { browserProfileKey } from "../../../shared/browser-profile";
import { randomUUID } from "node:crypto";
import type {
  BrowserVaultAnswer,
  BrowserVaultCommand,
  BrowserVaultFields,
  BrowserVaultItem,
  BrowserVaultPrompt,
} from "../../../shared/browser-vault";
import { AUTOFILL_WORLD_ID, type FillTarget } from "./autofill";
import { getBrowserVault, validateVaultFields, type BrowserVault } from "./vault";
import { loginOriginFor } from "./login-origin";
import { PasswordManagerVault } from "./password-managers";
import { buildSecureFill, secureFill } from "./secure-fill";
import { authenticatorCode, parseAuthenticator } from "./totp";
import { beginPrivateSurface } from "./private-capture-guard";

export interface CredentialTarget {
  contents: FillTarget & {
    id: number;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  workspaceId: string;
  tabId: string;
}
export interface BrowserCredentialDeps {
  target(taskId: string, sessionId: string): Promise<CredentialTarget | null>;
  canPrompt(): boolean;
  changed(): void;
  authorize(item: BrowserVaultItem, origin: string, purpose?: "code"): Promise<boolean>;
  audit?(taskId: string, data: Record<string, unknown>): void;
}
type Pending = {
  prompt: BrowserVaultPrompt;
  resolve: (answer: BrowserVaultAnswer | null) => void;
  timer: ReturnType<typeof setTimeout>;
  releasePrivacy: () => void;
};
export type CredentialResult = { success: boolean; error?: string; [key: string]: unknown };
class FlowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Deliberately whitelist the browser result; a future page helper cannot return secret values. */
function publicFillResult(value: unknown) {
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const success = result.success === true;
  return {
    success,
    filledFields:
      typeof result.filledFields === "number" && Number.isFinite(result.filledFields)
        ? Math.max(0, Math.min(128, Math.floor(result.filledFields)))
        : 0,
    filledPassword: result.filledPassword === true,
    ...(!success
      ? { error: result.error === "page_changed" ? "page_changed" : "no_matching_fields" }
      : {}),
  };
}

/** One trusted path for agent and toolbar operations. Prompt answers never become task messages. */
export class BrowserCredentialService {
  private pending = new Map<string, Pending>();
  private closedPromptPrivacy = new Map<string, () => void>();
  private busy = new Set<string>();
  private sensitiveDocuments = new Map<number, () => void>();
  hasPrivateSurface(): boolean {
    return (
      this.pending.size > 0 || this.closedPromptPrivacy.size > 0 || this.sensitiveDocuments.size > 0
    );
  }
  private protectDocument(contents: CredentialTarget["contents"]) {
    if (this.sensitiveDocuments.has(contents.id)) return;
    const releasePrivacy = beginPrivateSurface();
    const clear = () => {
      contents.removeListener?.("did-navigate", clear);
      contents.removeListener?.("destroyed", clear);
      this.sensitiveDocuments.delete(contents.id);
      releasePrivacy();
    };
    this.sensitiveDocuments.set(contents.id, clear);
    contents.on?.("did-navigate", clear);
    contents.on?.("destroyed", clear);
  }
  private declined = new Map<string, number>();
  constructor(
    private deps: BrowserCredentialDeps,
    private vault: BrowserVault = getBrowserVault(),
    readonly managers = new PasswordManagerVault(),
    private now = Date.now,
    private promptTtl = 5 * 60_000,
  ) {}
  prompts(): BrowserVaultPrompt[] {
    return [...this.pending.values()].map(({ prompt }) => ({ ...prompt }));
  }
  cancelTask(taskId: string) {
    for (const { prompt } of this.pending.values())
      if (prompt.taskId === taskId) this.respond(prompt.id, null);
  }
  hasPrompt(taskId?: string, sessionId?: string): boolean {
    return this.prompts().some(
      (p) => (!taskId || p.taskId === taskId) && (!sessionId || p.sessionId === sessionId),
    );
  }
  respond(id: string, answer: BrowserVaultAnswer | null): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    // The owner renderer must clear/unmount and paint before capture protection ends.
    this.closedPromptPrivacy.set(id, pending.releasePrivacy);
    const valid =
      answer === null ||
      (answer &&
        typeof answer === "object" &&
        answer.fields &&
        typeof answer.fields === "object" &&
        !Array.isArray(answer.fields) &&
        Object.keys(answer.fields).length <= 12 &&
        Object.values(answer.fields).every(
          (value) => typeof value === "string" && value.length <= 4096,
        ));
    pending.resolve(
      valid && pending.prompt.expiresAt > this.now() && answer
        ? { fields: answer.fields, remember: answer.remember === true }
        : null,
    );
    this.deps.audit?.(pending.prompt.taskId, {
      kind: "browser_vault_prompt_resolved",
      requestId: id,
      status:
        pending.prompt.expiresAt <= this.now()
          ? "expired"
          : valid && answer
            ? "submitted"
            : "cancelled",
    });
    this.deps.changed();
    return Boolean(valid);
  }
  dismissPrompt(id: string): boolean {
    const release = this.closedPromptPrivacy.get(id);
    if (!release) return false;
    release();
    this.closedPromptPrivacy.delete(id);
    return true;
  }
  dismissClosedPrompts() {
    for (const id of this.closedPromptPrivacy.keys()) this.dismissPrompt(id);
  }
  dispose() {
    for (const id of this.pending.keys()) this.respond(id, null);
    this.dismissClosedPrompts();
    for (const clear of this.sensitiveDocuments.values()) clear();
  }
  private prompt(
    data: Omit<BrowserVaultPrompt, "id" | "expiresAt">,
  ): Promise<BrowserVaultAnswer | null> {
    if (!this.deps.canPrompt() || this.pending.size >= 32)
      throw new FlowError("prompt_unavailable");
    const key = `${data.taskId}\0${data.sessionId}\0${data.origin}\0${data.kind}`;
    if ((this.declined.get(key) || 0) > this.now()) throw new FlowError("user_declined");
    for (const [key, until] of this.declined) if (until <= this.now()) this.declined.delete(key);
    const prompt: BrowserVaultPrompt = {
      ...data,
      id: randomUUID(),
      expiresAt: this.now() + this.promptTtl,
      ...(["login", "payment", "address"].includes(data.kind)
        ? { canRemember: this.vault.canStore() }
        : {}),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respond(prompt.id, null), this.promptTtl);
      this.pending.set(prompt.id, {
        prompt,
        timer,
        releasePrivacy: beginPrivateSurface(),
        resolve: (answer) => {
          if (!answer) this.declined.set(key, this.now() + this.promptTtl);
          resolve(answer);
        },
      });
      this.deps.audit?.(data.taskId, {
        kind: "browser_vault_prompt",
        requestId: prompt.id,
        origin: prompt.origin,
        promptKind: prompt.kind,
        expiresAt: prompt.expiresAt,
      });
      this.deps.changed();
    });
  }
  executeFromUser(taskId: string, command: BrowserVaultCommand) {
    const prefix = `${taskId}\0${command.session_id || "default"}\0`;
    for (const key of this.declined.keys()) if (key.startsWith(prefix)) this.declined.delete(key);
    return this.execute(taskId, command);
  }
  async execute(
    taskId: string,
    command: BrowserVaultCommand,
    approvePayment?: (item: BrowserVaultItem, origin: string) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<CredentialResult> {
    const sessionId = command.session_id || "default";
    const key = `${taskId}\0${sessionId}`;
    if (this.busy.has(key)) return { success: false, error: "credential_operation_pending" };
    this.busy.add(key);
    let cleanUp = () => {};
    let transient: BrowserVaultFields | null = null;
    let writeAttempted = false;
    try {
      if (signal?.aborted) throw new FlowError("cancelled");
      if (
        !taskId ||
        !["list", "save_login", "save_item", "fill", "enter_code", "unlock", "lock"].includes(
          command.action,
        )
      )
        throw new FlowError("invalid_request");
      const first = await this.deps.target(taskId, sessionId);
      if (!first || first.contents.isDestroyed()) throw new FlowError("visible_browser_required");
      const url = first.contents.getURL();
      const origin = loginOriginFor(url);
      if (!origin) throw new FlowError("secure_origin_required");
      const workspaceId = first.workspaceId;
      const scope = browserProfileKey(workspaceId);
      const source = command.source;
      const documentToken = randomUUID();
      let changed = false;
      const invalidate = () => {
        changed = true;
        for (const { prompt } of this.pending.values())
          if (prompt.taskId === taskId && prompt.sessionId === sessionId)
            this.respond(prompt.id, null);
      };
      signal?.addEventListener("abort", invalidate, { once: true });
      first.contents.on?.("did-start-navigation", invalidate);
      first.contents.on?.("destroyed", invalidate);
      const authorityWatch = setInterval(() => {
        if (this.hasPrompt(taskId, sessionId)) void assertCurrent().catch(invalidate);
      }, 1000);
      cleanUp = () => {
        clearInterval(authorityWatch);
        signal?.removeEventListener("abort", invalidate);
        first.contents.removeListener?.("did-start-navigation", invalidate);
        first.contents.removeListener?.("destroyed", invalidate);
      };
      const assertCurrent = async () => {
        if (signal?.aborted) throw new FlowError("cancelled");
        const current = await this.deps.target(taskId, sessionId);
        if (
          changed ||
          !current ||
          current.workspaceId !== workspaceId ||
          current.tabId !== first.tabId ||
          current.contents.id !== first.contents.id ||
          current.contents.isDestroyed() ||
          current.contents.getURL() !== url
        )
          throw new FlowError("page_or_authority_changed");
      };
      if (signal?.aborted) throw new FlowError("cancelled");
      const ask = (kind: BrowserVaultPrompt["kind"], manager?: BrowserVaultPrompt["source"]) =>
        this.prompt({ taskId, sessionId, origin, kind, source: manager });
      if (command.action === "lock" || command.action === "unlock") {
        if (source !== "onepassword" && source !== "bitwarden")
          throw new FlowError("invalid_manager");
        if (command.action === "lock") {
          this.managers.lock(scope, source);
          return { success: true, source, locked: true };
        }
        if (!this.managers.isUnlocked(scope, source)) {
          const answer = await ask("unlock", source);
          if (!answer) throw new FlowError("user_declined");
          transient = answer.fields;
          await assertCurrent();
          await this.managers.unlock(scope, source, transient.password || "");
          try {
            await assertCurrent();
          } catch (error) {
            this.managers.lock(scope, source);
            throw error;
          }
        }
        await assertCurrent();
        return { success: true, source, unlocked: true };
      }
      const all = async () => {
        const items = this.vault.listItems(scope);
        for (const manager of ["onepassword", "bitwarden"] as const) {
          if (this.managers.isUnlocked(scope, manager)) {
            try {
              items.push(...(await this.managers.list(scope, manager)));
            } catch {
              this.managers.lock(scope, manager);
            }
          }
        }
        return items.filter((item) => item.allowedOrigins.includes(origin));
      };
      if (command.action === "list") {
        const items = await all();
        const sources = await this.managers.sources(scope);
        await assertCurrent();
        return { success: true, origin, items, sources, canStore: this.vault.canStore() };
      }
      await first.contents.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
        { code: `globalThis.__coworkVaultDocument = ${JSON.stringify(documentToken)}; true` },
      ]);
      let item: BrowserVaultItem | undefined;
      if (command.action === "save_login" || command.action === "save_item") {
        const kind = command.action === "save_login" ? "login" : command.kind;
        if (kind !== "login" && kind !== "payment" && kind !== "address")
          throw new FlowError("invalid_item_kind");
        const answer = await ask(kind);
        if (!answer) throw new FlowError("user_declined");
        transient = validateVaultFields(kind, answer.fields);
        for (const field of Object.keys(answer.fields)) answer.fields[field] = "";
        await assertCurrent();
        if (kind === "login" && (!transient.username || !transient.password))
          throw new FlowError("missing_login_fields");
        if (transient.otpSecret) parseAuthenticator(transient.otpSecret);
        item = answer.remember
          ? this.vault.addItem(scope, kind, origin, transient)
          : {
              id: "use-once",
              kind,
              label: new URL(origin).host,
              origin,
              allowedOrigins: [origin],
              source: "local",
              username: kind === "login" ? transient.username : undefined,
            };
      } else if (command.handle) {
        item = (await all()).find((candidate) => candidate.id === command.handle);
        if (!item) throw new FlowError("login_not_available_for_origin");
      }
      if (command.action === "enter_code") {
        const probe = (await first.contents.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
          { code: buildSecureFill({ code: "" }, "code", origin, documentToken, true) },
        ])) as { fillable?: boolean };
        if (!probe?.fillable)
          return {
            success: false,
            error: "no_code_field",
            manualActionRequired: true,
            message:
              "If the site asks for a passkey, security key or device approval, complete it on your device, then verify the page.",
          };
        if (item) {
          if (item.kind !== "login") throw new FlowError("invalid_login_handle");
          const decision = `${key}\0${origin}\0code:${item.id}`;
          if ((this.declined.get(decision) || 0) > this.now()) throw new FlowError("user_declined");
          if (!(await this.deps.authorize(item, origin, "code"))) {
            this.declined.set(decision, this.now() + this.promptTtl);
            throw new FlowError("user_declined");
          }
          await assertCurrent();
          if (item.source === "local")
            transient = await this.vault.withItemSecret(scope, item.id, (fields) => ({
              code: fields.otpSecret ? authenticatorCode(fields.otpSecret, this.now()) : "",
            }));
          else transient = { code: await this.managers.otp(scope, item) };
        }
        if (!transient?.code) {
          const answer = await ask("code");
          if (!answer) throw new FlowError("user_declined");
          transient = { code: (answer.fields.code || "").replace(/[\s-]/g, "") };
        }
        if (!/^[a-zA-Z0-9]{4,12}$/.test(transient.code))
          throw new FlowError("invalid_verification_code");
        await assertCurrent();
        this.protectDocument(first.contents);
        writeAttempted = true;
        const result = await secureFill(
          first.contents,
          transient,
          "code",
          origin,
          documentToken,
          taskId,
          sessionId,
        );
        return {
          ...publicFillResult(result),
          origin,
          authenticationVerified: false,
        };
      }
      if (!item) throw new FlowError("login_handle_required");
      const fillDecision = `${key}\0${origin}\0fill:${item.id}`;
      if ((this.declined.get(fillDecision) || 0) > this.now()) throw new FlowError("user_declined");
      // Card confirmation cannot be auto-approved and never authorizes submitting an order.
      if (item.kind === "payment" && approvePayment && !(await approvePayment(item, origin))) {
        this.declined.set(fillDecision, this.now() + this.promptTtl);
        throw new FlowError("payment_declined");
      }
      if (!(await this.deps.authorize(item, origin))) {
        this.declined.set(fillDecision, this.now() + this.promptTtl);
        throw new FlowError(item.kind === "payment" ? "payment_declined" : "user_declined");
      }
      await assertCurrent();
      if (!transient)
        transient =
          item.source === "local"
            ? await this.vault.withItemSecret(scope, item.id, (fields) => ({ ...fields }))
            : await this.managers.resolve(scope, item);
      if (item.kind === "payment" && !transient.cvc) {
        const answer = await ask("card_code");
        if (!answer) throw new FlowError("user_declined");
        // Never silently replace the already-approved card with a new one.
        transient.cvc = answer.fields.cvc || "";
      }
      await assertCurrent();
      this.protectDocument(first.contents);
      writeAttempted = true;
      const result = await secureFill(
        first.contents,
        transient,
        item.kind,
        origin,
        documentToken,
        taskId,
        sessionId,
      );
      this.deps.audit?.(taskId, {
        kind: "browser_vault_fill",
        origin,
        itemKind: item.kind,
        source: item.source,
      });
      return {
        ...publicFillResult(result),
        origin,
        handle: item.id === "use-once" ? undefined : item.id,
        kind: item.kind,
        authenticationVerified: false,
        next:
          item.kind === "login"
            ? "Submit the login form. If this was a username-only step, continue and fill again. If a code is required, use enter_code. Verify the authenticated page before reporting sign-in success."
            : item.kind === "payment"
              ? "Card fields filled. Obtain separate approval before placing an order."
              : "Address fields filled.",
      };
    } catch (error) {
      if (writeAttempted)
        return {
          success: false,
          error: "fill_outcome_unknown",
          outcomeUnknown: true,
          message:
            "The page changed or the fill was interrupted. Inspect the current page to reconcile the result; do not automatically repeat credential entry.",
        };
      return {
        success: false,
        error: error instanceof FlowError ? error.code : "credential_operation_failed",
        message:
          "Use the private browser controls to resolve this. Do not ask for secrets in chat or repeat a declined request.",
      };
    } finally {
      if (transient) for (const field of Object.keys(transient)) transient[field] = "";
      cleanUp();
      this.busy.delete(key);
    }
  }
}

let service: BrowserCredentialService | null = null;
export function configureBrowserCredentialService(
  deps: BrowserCredentialDeps,
): BrowserCredentialService {
  service?.dispose();
  service = new BrowserCredentialService(deps);
  return service;
}
export function getBrowserCredentialService(): BrowserCredentialService | null {
  return service;
}
