import type { PactEffectClass, PactSendOutcome } from "../../../shared/pact";
import type { RuntimeToolMetadata, Task, Workspace } from "../../../shared/types";
import { isAutomatedTaskLike } from "../../../shared/automated-task-detection";
import { getPactPolicy } from "../../admin/policies";
import { networkContextOf } from "../../pact/daemon-host";
import { redactPact, redactPactError } from "../../pact/redaction";
import { pactToolsExposed } from "../../pact/routing";
import type { PactCallContext } from "../../pact/runtime";
import { PactSettingsManager } from "../../pact/settings";
import { isHeadlessMode } from "../../utils/runtime-mode";
import { canAnswerInlineApproval } from "../approval-policy";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";

export const PACT_TOOL_NAMES = ["pact_discover", "pact_send_message", "pact_get_conversation"] as const;

const EFFECTS: readonly PactEffectClass[] = ["inspect", "change", "unknown"];
const MAX_SCOPES = 20;

function stringInput(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function scopesInput(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 200))
    .slice(0, MAX_SCOPES);
}

/**
 * PACT business-agent tools: talk to a business's own agent with the user's identity and, when
 * the business offers it, the account permissions the user approves on the business's own login.
 * The runtime (src/electron/pact) is the authority: it admits each operation, asks for approval,
 * runs consent, sends, and verifies receipts. The model only sees handles, reply text, scope
 * descriptions and evidence status, never tokens, codes, sign-in links or signer configuration.
 */
export class PactTools {
  constructor(
    private workspace: Workspace,
    private readonly daemon: AgentDaemon,
    private readonly taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isAvailable(): boolean {
    try {
      return pactToolsExposed({
        settings: PactSettingsManager.loadSettings(),
        policy: getPactPolicy(),
      });
    } catch {
      return false;
    }
  }

  /** Auto-routing off (admin `pact.autoRoute: false`): offer the tools only when asked by name. */
  static autoRouteEnabled(): boolean {
    try {
      return getPactPolicy().autoRoute;
    } catch {
      return false;
    }
  }

  getToolDefinitions(): LLMTool[] {
    const exposure: RuntimeToolMetadata["exposure"] = PactTools.autoRouteEnabled()
      ? "conditional"
      : "explicit_only";
    const readRuntime: RuntimeToolMetadata = {
      concurrencyClass: "read_parallel" as const,
      readOnly: true,
      approvalKind: "none" as const,
      sideEffectLevel: "none" as const,
      interruptBehavior: "cancel" as const,
      deferLoad: true,
      alwaysExpose: false,
      resultKind: "integration" as const,
      supportsContextMutation: false,
      capabilityTags: ["business", "integration"],
      exposure,
    };
    return [
      {
        name: "pact_discover",
        description:
          "Use when the user wants something done with a specific business (an order, booking, account, delivery or support question) to check whether that business has its own PACT agent CoWork can talk to. Give the business's own domain or the agent card URL the user supplied; never guess a business. Returns an opaque business_id, the permissions the business can ask for, and whether to use PACT or another route. Discovery sends nothing about the user.",
        input_schema: {
          type: "object",
          properties: {
            domain: { type: "string", description: "The business's own domain, e.g. example.com" },
            card_url: {
              type: "string",
              description: "An HTTPS agent card URL the user or the business provided",
            },
            refresh: { type: "boolean", description: "Fetch the card again instead of using the cache" },
          },
          required: [],
        },
        runtime: { ...readRuntime },
      },
      {
        name: "pact_send_message",
        description:
          "Use to send one message to a business's PACT agent (from pact_discover) and get its reply. Write the message yourself from only the facts the business needs for this request (order number, dates); never paste the conversation, files, memory, credentials or card numbers. Set effect to 'inspect' for questions and lookups, 'change' for anything that changes the account (cancel, rebook, refund, update), or 'unknown'. List required_scopes from the business's permissions when the request needs account access. CoWork asks the user for approval and for sign-in on the business's own page when needed. If the result is outcome_unknown, do not retry another way; pass reconcile_operation_id later instead.",
        input_schema: {
          type: "object",
          properties: {
            business_id: { type: "string", description: "business_id from pact_discover" },
            message: { type: "string", description: "The text to send to the business's agent" },
            effect: {
              type: "string",
              enum: [...EFFECTS],
              description: "inspect, change or unknown",
            },
            required_scopes: {
              type: "array",
              items: { type: "string" },
              description: "Permission ids from pact_discover this request needs",
            },
            conversation_id: {
              type: "string",
              description: "Continue an earlier conversation with this business",
            },
            purpose: {
              type: "string",
              description: "One line shown to the user when they are asked to sign in",
            },
            reconcile_operation_id: {
              type: "string",
              description: "Resend an operation whose outcome was unknown, unchanged",
            },
          },
          required: ["business_id", "message", "effect"],
        },
        runtime: {
          concurrencyClass: "exclusive",
          readOnly: false,
          // Not workspace_policy: that kind skips runtime approval. The PACT admission service
          // is the authoritative gate either way (it asks for approval itself).
          approvalKind: "external_service",
          sideEffectLevel: "high",
          interruptBehavior: "block",
          deferLoad: true,
          alwaysExpose: false,
          resultKind: "integration",
          supportsContextMutation: false,
          capabilityTags: ["business", "integration"],
          exposure,
        },
      },
      {
        name: "pact_get_conversation",
        description:
          "Use to review an earlier PACT conversation with a business: the messages CoWork sent, the replies, and whether each reply carried verified evidence (a signed receipt).",
        input_schema: {
          type: "object",
          properties: {
            conversation_id: { type: "string", description: "conversation_id from pact_send_message" },
          },
          required: ["conversation_id"],
        },
        runtime: { ...readRuntime },
      },
    ];
  }

  private task(): Task | undefined {
    return this.daemon.getTask(this.taskId);
  }

  /** Where this call comes from, decided from the task record, never from tool input. */
  private callContext(signal?: AbortSignal): PactCallContext {
    const task = this.task();
    const agentConfig = task?.agentConfig;
    const origin: PactCallContext["origin"] = !task
      ? "automation"
      : task.parentTaskId
        ? "sub_agent"
        : agentConfig?.gatewayContext
          ? "gateway"
          : isAutomatedTaskLike(task)
            ? "automation"
            : agentConfig?.cli?.owner === "cowork-run"
              ? "owner_cli"
              : "owner";
    const interactive = canAnswerInlineApproval(task, { headless: isHeadlessMode() });
    const humanInput: PactCallContext["humanInput"] = interactive
      ? "interactive"
      : origin === "owner_cli"
        ? "out_of_band"
        : "none";
    const effective = this.daemon.getEffectiveWorkspaceForTask(this.taskId) ?? this.workspace;
    return {
      taskId: this.taskId,
      workspaceId: this.workspace.id,
      origin,
      localAuthority: "task",
      humanInput,
      // `cowork run` prints the sign-in link and keeps waiting (or exits with a distinct code
      // when unattended); either way the poll runs here until the sign-in settles.
      waitForConsent: humanInput !== "none",
      networkContext: networkContextOf(effective) ?? { networkEnabled: false },
      ...(signal ? { signal } : {}),
    };
  }

  private principal() {
    return this.daemon.getPactRuntime().ownerPrincipal(`task:${this.taskId}`);
  }

  /** The runtime-supplied destination for PermissionEngine domain rules (plan §7). */
  async approvalDestination(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    const record = (input ?? {}) as Record<string, unknown>;
    try {
      if (toolName === "pact_discover") {
        const cardUrl = stringInput(record.card_url, 2048);
        const domain = stringInput(record.domain, 253);
        const url = cardUrl ?? (domain ? `https://${domain}/.well-known/agent-card.json` : undefined);
        return url ? { permissionInput: { url } } : {};
      }
      if (toolName === "pact_send_message") {
        const businessId = stringInput(record.business_id, 200);
        if (!businessId) return {};
        const business = await this.daemon.getPactRuntime().repo.getBusiness(businessId);
        return business
          ? {
              permissionInput: { url: business.interfaceUrl },
              pactDestination: { interfaceUrl: business.interfaceUrl, originChain: business.originChain },
            }
          : {};
      }
    } catch {
      // No destination fact; the runtime still checks every hop itself.
    }
    return {};
  }

  async discover(input: unknown) {
    const record = (input ?? {}) as Record<string, unknown>;
    const domain = stringInput(record.domain, 253);
    const cardUrl = stringInput(record.card_url, 2048);
    if (!domain && !cardUrl) {
      return { success: false, error: "Provide the business's domain or an agent card URL." };
    }
    try {
      const { business, route } = await this.daemon.getPactRuntime().discover(
        await this.principal(),
        { ...(domain ? { domain } : {}), ...(cardUrl ? { cardUrl } : {}), refresh: record.refresh === true },
        this.callContext(),
      );
      return {
        success: true,
        business_id: business.id,
        name: business.displayName,
        // Provenance: the name proves nothing; where the card came from does.
        reached_via: business.originChain.map((url) => new URL(url).origin),
        provider: business.providerOrigin,
        supported: business.supported,
        ...(business.unsupportedReason ? { unsupported_reason: business.unsupportedReason } : {}),
        account_access: business.profile === "delegated",
        permissions: business.scopes,
        skills: business.skills.map((skill) => ({ name: skill.name, description: skill.description })),
        route: route.route,
        guidance:
          route.route === "pact"
            ? "Use pact_send_message with this business_id."
            : route.message,
      };
    } catch (error) {
      return { success: false, error: redactPactError(error) };
    }
  }

  async sendMessage(input: unknown, signal?: AbortSignal) {
    const record = (input ?? {}) as Record<string, unknown>;
    const businessId = stringInput(record.business_id, 200);
    const reconcile = stringInput(record.reconcile_operation_id, 200);
    const message = typeof record.message === "string" ? record.message : "";
    const effect = EFFECTS.includes(record.effect as PactEffectClass)
      ? (record.effect as PactEffectClass)
      : "unknown";
    if (!businessId) return { success: false, error: "business_id is required (from pact_discover)." };
    if (!reconcile && !message.trim()) return { success: false, error: "message is required." };
    try {
      const conversationId = stringInput(record.conversation_id, 200);
      const purpose = stringInput(record.purpose, 300);
      const outcome = await this.daemon.getPactRuntime().send(
        await this.principal(),
        {
          businessId,
          text: message,
          effect,
          requiredScopes: scopesInput(record.required_scopes),
          ...(conversationId ? { conversationId } : {}),
          ...(purpose ? { purpose } : {}),
          ...(reconcile ? { reconcileOperationId: reconcile } : {}),
        },
        this.callContext(signal),
      );
      return this.toToolResult(outcome);
    } catch (error) {
      return { success: false, error: redactPactError(error) };
    }
  }

  private toToolResult(outcome: PactSendOutcome) {
    switch (outcome.status) {
      case "replied":
        return {
          success: true,
          status: "replied",
          conversation_id: outcome.conversationId,
          reply: outcome.replyText,
          evidence: outcome.evidence,
          note:
            outcome.evidence === "verified"
              ? "The business signed a receipt for this reply. A receipt proves what the business reported, not that it settled."
              : outcome.evidence === "not_applicable"
                ? "No account permission was used, so no receipt is expected."
                : "This reply has no verified receipt; tell the user the outcome is unverified.",
        };
      case "needs_user_action":
        return {
          success: false,
          status: "needs_user_action",
          conversation_id: outcome.conversationId || undefined,
          message: `${outcome.message} The sign-in link is shown to the user, not to you.`,
          permissions: outcome.scopes,
        };
      default:
        return redactPact({
          success: false,
          status: outcome.status,
          reason: outcome.reason,
          conversation_id: outcome.conversationId,
          message: outcome.message,
        });
    }
  }

  async getConversation(input: unknown) {
    const record = (input ?? {}) as Record<string, unknown>;
    const conversationId = stringInput(record.conversation_id, 200);
    if (!conversationId) return { success: false, error: "conversation_id is required." };
    const view = await this.daemon.getPactRuntime().getConversation(await this.principal(), conversationId);
    if (!view) return { success: false, error: "Unknown conversation." };
    return {
      success: true,
      conversation_id: view.id,
      business: view.businessName,
      state: view.state,
      ...(view.stateReason ? { state_reason: view.stateReason } : {}),
      turns: view.turns.map((turn) => ({
        operation_id: turn.operationId,
        sent: turn.text,
        state: turn.state,
        effect: turn.effectClass,
        reply: turn.replyText,
        evidence: turn.evidence,
      })),
    };
  }
}
