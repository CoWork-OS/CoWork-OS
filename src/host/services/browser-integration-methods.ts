import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import type { ChannelGateway } from "../../electron/gateway";
import {
  ManagedAccountManager,
  type ManagedAccountRecord,
  type ManagedAccountStatus,
  type UpsertManagedAccountInput,
} from "../../electron/accounts/managed-account-manager";
import { SecureSettingsRepository } from "../../electron/database/SecureSettingsRepository";
import { getSkillRegistry, type SkillRegistry } from "../../electron/agent/skill-registry";
import {
  getCustomSkillLoader,
  type CustomSkillLoader,
} from "../../electron/agent/custom-skill-loader";
import { AddChannelSchema } from "../../electron/utils/validation";
import { getSafeStorage } from "../../electron/utils/safe-storage";
import type {
  AddChannelRequest,
  SkillInstallProgress as RegistryInstallProgress,
} from "../../shared/types";
import type { BrowserDesktopDefinition, BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

type Gateway = Pick<
  ChannelGateway,
  | "addTelegramChannel"
  | "addDiscordChannel"
  | "addSlackChannel"
  | "addWhatsAppChannel"
  | "addImessageChannel"
  | "addSignalChannel"
  | "addMattermostChannel"
  | "addMatrixChannel"
  | "addTwitchChannel"
  | "addLineChannel"
  | "addBlueBubblesChannel"
  | "addGoogleChatChannel"
  | "addFeishuChannel"
  | "addWeComChannel"
  | "addWhatsAppCloudChannel"
  | "addTwilioSmsChannel"
  | "addXChannel"
  | "addEmailChannel"
  | "updateChannel"
  | "removeChannel"
  | "enableChannel"
  | "disableChannel"
  | "getChannel"
  | "getChannelUsers"
  | "grantUserAccess"
  | "revokeUserAccess"
  | "generatePairingCode"
  | "testChannel"
  | "getChannelHealth"
  | "getChannels"
  | "getWhatsAppInfo"
  | "enableWhatsAppWithQRForwarding"
  | "whatsAppLogout"
>;

type SkillRegistryPort = Pick<
  SkillRegistry,
  "install" | "installFromClawHub" | "installFromUrl" | "installFromGit" | "uninstall"
>;

type SkillLoaderPort = Pick<
  CustomSkillLoader,
  "initialize" | "reloadSkills" | "clearEligibilityCache"
>;

type ManagedAccountPort = Pick<
  typeof ManagedAccountManager,
  "list" | "getById" | "upsert" | "remove" | "toPublicView"
>;

export interface BrowserIntegrationMethodOptions {
  channelGateway?: Gateway;
  skillRegistry?: SkillRegistryPort;
  skillLoader?: SkillLoaderPort;
  managedAccounts?: ManagedAccountPort;
  /** Required before honoring a workspace-scoped gateway signal request. */
  authorizeWorkspaceRead?: (workspaceId: string, sessionId: string) => Promise<void> | void;
  /** Injectable so browser method tests can verify the Node-host storage boundary. */
  channelCredentialStorageAvailable?: () => boolean;
}

type SkillInstallProgress = {
  status: "starting" | "downloading" | "checking" | "installing" | "completed" | "failed";
  progress: number;
  message: string;
};

type SkillInstallJob = SkillInstallProgress & { updatedAt: number; owner: string };

const ACCOUNT_STATUSES = [
  "draft",
  "pending_signup",
  "pending_verification",
  "active",
  "blocked",
  "disabled",
  "error",
] as const satisfies readonly ManagedAccountStatus[];

const ACCOUNT_SECRET_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const URL_CONFIG_KEYS = new Set(["serverUrl", "homeserver", "loomBaseUrl", "webhookPublicUrl"]);
const MAX_GATEWAY_SIGNAL_CHANNELS = 100;
const MAX_GATEWAY_SIGNAL_USERS = 500;
const ACCOUNT_MAX = 500;
const CHANNEL_PUBLIC_CONFIG_KEYS: Record<string, Set<string>> = {
  telegram: new Set(["groupRoutingMode", "allowedGroupChatIds"]),
  discord: new Set(["supervisor", "applicationId", "guildIds"]),
  slack: new Set(["progressRelayMode"]),
  whatsapp: new Set([
    "selfChatMode",
    "responsePrefix",
    "ingestNonSelfChatsInSelfChatMode",
    "ambientMode",
    "silentUnauthorized",
    "allowedNumbers",
    "trustedGroupMemoryOptIn",
    "sendReadReceipts",
    "deduplicationEnabled",
    "groupRoutingMode",
  ]),
  imessage: new Set([
    "dmPolicy",
    "groupPolicy",
    "allowedContacts",
    "ambientMode",
    "silentUnauthorized",
    "captureSelfMessages",
  ]),
  signal: new Set([
    "phoneNumber",
    "mode",
    "trustMode",
    "dmPolicy",
    "groupPolicy",
    "allowedNumbers",
    "sendReadReceipts",
    "sendTypingIndicators",
  ]),
  mattermost: new Set(["serverUrl", "teamId"]),
  matrix: new Set(["homeserver", "userId", "deviceId", "roomIds"]),
  twitch: new Set(["username", "channels", "allowWhispers"]),
  line: new Set(["webhookPort"]),
  bluebubbles: new Set([
    "serverUrl",
    "webhookPort",
    "allowedContacts",
    "ambientMode",
    "silentUnauthorized",
    "captureSelfMessages",
  ]),
  googlechat: new Set(["projectId", "webhookPort", "webhookPath", "displayName", "responsePrefix"]),
  feishu: new Set(["webhookPort", "webhookPath", "displayName", "responsePrefix"]),
  wecom: new Set(["agentId", "webhookPort", "webhookPath", "displayName", "responsePrefix"]),
  teams: new Set(["appId", "tenantId", "displayName", "webhookPort", "responsePrefix"]),
  whatsapp_cloud: new Set([
    "phoneNumberId",
    "fallbackTemplateName",
    "fallbackTemplateLanguage",
    "webhookPort",
    "webhookPath",
  ]),
  twilio_sms: new Set([
    "accountSid",
    "fromNumber",
    "messagingServiceSid",
    "webhookPublicUrl",
    "webhookPort",
    "webhookPath",
    "statusPath",
  ]),
  x: new Set([
    "commandPrefix",
    "allowedAuthors",
    "pollIntervalSec",
    "fetchCount",
    "outboundEnabled",
  ]),
  email: new Set([
    "protocol",
    "email",
    "authMethod",
    "oauthProvider",
    "oauthClientId",
    "oauthTenant",
    "scopes",
    "imapHost",
    "imapPort",
    "imapSecure",
    "smtpHost",
    "smtpPort",
    "smtpSecure",
    "displayName",
    "allowedSenders",
    "subjectFilter",
    "loomBaseUrl",
    "loomIdentity",
    "loomMailboxFolder",
    "loomPollInterval",
    "tokenExpiresAt",
    "microsoftGraphTokenExpiresAt",
    "microsoftGraphTokenScopes",
  ]),
};
const CHANNEL_CREDENTIAL_CONFIG_KEYS: Record<string, Set<string>> = {
  telegram: new Set(["botToken"]),
  discord: new Set(["botToken"]),
  slack: new Set(["botToken", "appToken", "signingSecret"]),
  whatsapp: new Set(),
  imessage: new Set(),
  signal: new Set(),
  mattermost: new Set(["token"]),
  matrix: new Set(["accessToken"]),
  twitch: new Set(["oauthToken"]),
  line: new Set(["channelAccessToken", "channelSecret"]),
  bluebubbles: new Set(["password", "webhookSecret"]),
  googlechat: new Set(["serviceAccountKeyPath", "serviceAccountKey", "webhookSecret"]),
  feishu: new Set(["appSecret", "verificationToken", "encryptKey"]),
  wecom: new Set(["secret", "token", "encodingAESKey"]),
  teams: new Set(["appPassword"]),
  whatsapp_cloud: new Set(["accessToken", "appSecret", "verifyToken"]),
  twilio_sms: new Set(["authToken"]),
  x: new Set(["oauthToken"]),
  email: new Set([
    "password",
    "oauthClientSecret",
    "accessToken",
    "refreshToken",
    "loomAccessToken",
    "microsoftGraphAccessToken",
    "microsoftGraphRefreshToken",
  ]),
};
const CHANNEL_UPDATE_CONFIG_KEYS = new Set([
  "selfChatMode",
  "supervisor",
  "progressRelayMode",
  "responsePrefix",
  "trustedGroupMemoryOptIn",
  "researchChatIds",
  "researchAgentRoleId",
  "ambientMode",
  "silentUnauthorized",
  "ingestNonSelfChatsInSelfChatMode",
  "sendReadReceipts",
  "deduplicationEnabled",
  "groupRoutingMode",
  "allowedNumbers",
  "allowedGroupChatIds",
  "allowedContacts",
  "allowedSenders",
  "subjectFilter",
  "twitchChannels",
  "twitchAllowWhispers",
  "allowedAuthors",
  "outboundEnabled",
  "pollIntervalSec",
  "fetchCount",
  "cliPath",
  "dbPath",
  "captureSelfMessages",
  "phoneNumber",
  "dataDir",
  "mode",
  "trustMode",
  "serverUrl",
  "teamId",
  "homeserver",
  "userId",
  "deviceId",
  "roomIds",
  "username",
  "channels",
  "webhookPort",
  "webhookPath",
  "displayName",
  "projectId",
  "fallbackTemplateName",
  "fallbackTemplateLanguage",
  "accountSid",
  "fromNumber",
  "messagingServiceSid",
  "webhookPublicUrl",
  "statusPath",
  "commandPrefix",
  "protocol",
  "email",
  "authMethod",
  "oauthProvider",
  "oauthClientId",
  "oauthTenant",
  "scopes",
  "imapHost",
  "imapPort",
  "imapSecure",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "loomBaseUrl",
  "loomIdentity",
  "loomMailboxFolder",
  "loomPollInterval",
  "tokenExpiresAt",
  "botToken",
  "applicationId",
  "guildIds",
  "appToken",
  "signingSecret",
  "token",
  "accessToken",
  "oauthToken",
  "channelAccessToken",
  "channelSecret",
  "password",
  "webhookSecret",
  "serviceAccountKeyPath",
  "serviceAccountKey",
  "appId",
  "tenantId",
  "appSecret",
  "verificationToken",
  "encryptKey",
  "corpId",
  "agentId",
  "secret",
  "encodingAESKey",
  "authToken",
  "verifyToken",
  "oauthClientSecret",
  "refreshToken",
  "loomAccessToken",
  "microsoftGraphAccessToken",
  "microsoftGraphRefreshToken",
  "microsoftGraphTokenExpiresAt",
  "microsoftGraphTokenScopes",
  "appPassword",
  "microsoftGraphTokenExpiresAt",
  "microsoftGraphTokenScopes",
]);

function invalidRequest(): never {
  throw new WebApplicationError("INVALID_REQUEST", "Invalid browser integration request.", 400);
}

function definition(
  handler: BrowserDesktopDefinition["handler"],
  options: Pick<BrowserDesktopDefinition, "mutation" | "minArgs" | "maxArgs" | "validate"> = {},
): BrowserDesktopDefinition {
  return { capability: "connectors.configure", ...options, handler };
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidRequest();
  return parsed.data;
}

function safeWebUrl(value: unknown, maxLength = 2048): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, maxLength);
  } catch {
    return undefined;
  }
}

function parseSingleArg<T>(schema: z.ZodType<T>) {
  return (args: unknown[]) => [parseSchema(schema, args[0])];
}

function parseString(value: unknown, maxLength = 180): string {
  if (typeof value !== "string") return invalidRequest();
  const parsed = z.string().trim().min(1).max(maxLength).safeParse(value);
  return parsed.success ? parsed.data : invalidRequest();
}

function parseUuid(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : invalidRequest();
}

function parseGatewaySignalRequest(value: unknown): { workspaceId?: string } {
  const parsed = parseSchema(
    z.object({ workspaceId: z.string().uuid().optional() }).strict(),
    value,
  );
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseStrictAddChannel(value: unknown): AddChannelRequest {
  if (!isRecord(value)) return invalidRequest();
  const parsed = AddChannelSchema.safeParse(value);
  if (!parsed.success) return invalidRequest();
  const sanitized = parsed.data as unknown as Record<string, unknown>;
  if (Object.keys(value).some((key) => !Object.hasOwn(sanitized, key))) return invalidRequest();
  return parsed.data as unknown as AddChannelRequest;
}

const channelUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(500).optional(),
    securityMode: z.enum(["open", "allowlist", "pairing"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const supervisorConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    coordinationChannelId: z.string().max(100).optional(),
    watchedChannelIds: z.array(z.string().max(100)).max(100).optional(),
    workerAgentRoleId: z.string().uuid().optional(),
    supervisorAgentRoleId: z.string().uuid().optional(),
    humanEscalationChannelId: z.string().max(100).optional(),
    humanEscalationUserId: z.string().max(100).optional(),
    peerBotUserIds: z.array(z.string().max(100)).max(20).optional(),
    strictMode: z.boolean().optional(),
  })
  .strict();

function parseChannelConfigUpdate(
  channelType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (JSON.stringify(config).length > 64 * 1024) return invalidRequest();
  const allowed = new Set([
    ...(CHANNEL_PUBLIC_CONFIG_KEYS[channelType] || []),
    ...(CHANNEL_CREDENTIAL_CONFIG_KEYS[channelType] || []),
    ...(channelType === "discord" ? ["guildIds"] : []),
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!allowed.has(key) || !CHANNEL_UPDATE_CONFIG_KEYS.has(key)) return invalidRequest();
    if (key === "supervisor") {
      sanitized[key] = parseSchema(supervisorConfigSchema, value);
    } else if (Array.isArray(value)) {
      if (
        value.length > 200 ||
        value.some((item) => typeof item !== "string" || item.length > 512)
      ) {
        return invalidRequest();
      }
      sanitized[key] = value;
    } else if (typeof value === "string") {
      if (value.length > 4096) return invalidRequest();
      sanitized[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        return invalidRequest();
      sanitized[key] = value;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    } else {
      return invalidRequest();
    }
  }
  return sanitized;
}

function safePublicConfigValue(key: string, value: unknown): unknown {
  if (key === "supervisor") {
    const parsed = supervisorConfigSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  if (typeof value === "string") {
    if (URL_CONFIG_KEYS.has(key)) return safeWebUrl(value, 512);
    return value.slice(0, 512);
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every((item) => typeof item === "string" && item.length <= 512)
  ) {
    return value;
  }
  return undefined;
}

function publicGatewayChannel(channel: {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status?: string;
  securityConfig?: { mode?: string };
  config?: Record<string, unknown>;
  configReadError?: string;
  createdAt?: number;
  updatedAt?: number;
}) {
  const publicKeys = CHANNEL_PUBLIC_CONFIG_KEYS[channel.type] || new Set<string>();
  const config = Object.fromEntries(
    Object.entries(channel.config || {})
      .filter(([key]) => publicKeys.has(key))
      .map(([key, value]) => [key, safePublicConfigValue(key, value)])
      .filter(([, value]) => value !== undefined),
  );
  const credentialKeys = CHANNEL_CREDENTIAL_CONFIG_KEYS[channel.type] || new Set<string>();
  const credentialConfigured = Boolean(
    !channel.configReadError &&
    Object.entries(channel.config || {}).some(
      ([key, value]) =>
        credentialKeys.has(key) &&
        (typeof value === "string" ? value.length > 0 : value !== undefined && value !== null),
    ),
  );
  return {
    ...publicChannel(channel),
    config,
    credentialConfigured,
    ...(channel.configReadError ? { configReadError: true } : {}),
  };
}

function boundedGatewayChannels(
  channels: ReturnType<Gateway["getChannels"]> extends Promise<infer T> ? T : never,
) {
  const selected = channels
    .slice(0, MAX_GATEWAY_SIGNAL_CHANNELS)
    .map((channel) => publicGatewayChannel(channel));
  while (selected.length > 0 && JSON.stringify(selected).length > 512 * 1024) selected.pop();
  return selected;
}

const managedAccountUpsertSchema = z
  .object({
    id: z.string().trim().min(1).max(180).optional(),
    provider: z.string().trim().min(1).max(120).optional(),
    label: z.string().trim().max(160).optional(),
    status: z.enum(ACCOUNT_STATUSES).optional(),
    signupUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => Boolean(safeWebUrl(value)))
      .optional(),
    dashboardUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => Boolean(safeWebUrl(value)))
      .optional(),
    docsUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => Boolean(safeWebUrl(value)))
      .optional(),
    secrets: z
      .record(z.string().regex(ACCOUNT_SECRET_KEY), z.string().max(4096))
      .refine((secrets) => Object.keys(secrets).length <= 64)
      .optional(),
    clearSecrets: z.boolean().optional(),
  })
  .strict();

const managedAccountListSchema = z
  .object({
    provider: z.string().trim().min(1).max(120).optional(),
    status: z.enum(ACCOUNT_STATUSES).optional(),
  })
  .strict();

function publicAccount(account: ManagedAccountRecord, manager: ManagedAccountPort) {
  const view = manager.toPublicView(account, false);
  const signupUrl = safeWebUrl(view.signupUrl);
  const dashboardUrl = safeWebUrl(view.dashboardUrl);
  const docsUrl = safeWebUrl(view.docsUrl);
  return {
    id: view.id,
    provider: view.provider,
    label: view.label,
    status: view.status,
    ...(signupUrl ? { signupUrl } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(view.secretKeys?.length ? { secretKeys: view.secretKeys.slice(0, 64) } : {}),
    ...(view.secretCount ? { secretCount: Math.min(view.secretCount, 64) } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function safeSkillProgress(
  status: SkillInstallProgress["status"],
  progress: unknown,
): Pick<SkillInstallProgress, "status" | "progress" | "message"> {
  const statusText: Record<SkillInstallProgress["status"], string> = {
    starting: "Starting install",
    downloading: "Downloading skill",
    checking: "Checking skill files",
    installing: "Installing skill",
    completed: "Skill installed",
    failed: "Install needs attention",
  };
  const numeric = typeof progress === "number" && Number.isFinite(progress) ? progress : 0;
  return {
    status,
    progress: Math.max(0, Math.min(100, Math.round(numeric))),
    message: statusText[status],
  };
}

function safeSkillInstallResult(result: Awaited<ReturnType<SkillRegistryPort["install"]>>) {
  if (!result.success || !result.skill) {
    return {
      success: false,
      error:
        result.security?.state === "quarantined"
          ? "This skill was quarantined by the host security review. Open its security report for details."
          : "The host could not install this skill. Check the source and try again.",
      ...(result.security
        ? { security: { state: result.security.state, summary: "Host security review completed." } }
        : {}),
    };
  }
  const skill = result.skill;
  return {
    success: true,
    skill: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      icon: skill.icon,
      prompt: "",
      category: skill.category,
      enabled: skill.enabled,
      type: skill.type,
      source: skill.source,
    },
    ...(result.security
      ? { security: { state: result.security.state, summary: "Host security review completed." } }
      : {}),
  };
}

function publicChannel(channel: {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status?: string;
  securityConfig?: { mode?: string };
  createdAt?: number;
  updatedAt?: number;
}) {
  return {
    id: channel.id.slice(0, 180),
    type: channel.type.slice(0, 40),
    name: channel.name.slice(0, 200),
    enabled: channel.enabled,
    status: (channel.status || "disconnected").slice(0, 40),
    ...(channel.securityConfig?.mode
      ? { securityMode: channel.securityConfig.mode.slice(0, 40) }
      : {}),
    ...(typeof channel.createdAt === "number" ? { createdAt: channel.createdAt } : {}),
    ...(typeof channel.updatedAt === "number" ? { updatedAt: channel.updatedAt } : {}),
  };
}

function safeGatewayFailure(error: unknown): WebApplicationError {
  const message = error instanceof Error ? error.message : "";
  if (/already configured/i.test(message)) {
    return new WebApplicationError(
      "CONFLICT",
      "This channel is already configured. Update or remove it first.",
      409,
    );
  }
  if (/not found/i.test(message)) {
    return new WebApplicationError("NOT_FOUND", "The channel is unavailable.", 404);
  }
  return new WebApplicationError(
    "INTERNAL_ERROR",
    "The host could not complete this channel action. Check the channel configuration and host status.",
    500,
  );
}

function safeChannelHealth(value: unknown) {
  if (!isRecord(value)) return undefined;
  const count = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.min(1_000_000_000, Math.floor(candidate)))
      : 0;
  const timestamp = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(candidate))
      : undefined;
  const deliveryStates = new Set(["queued", "sent", "delivered", "read", "failed", "undelivered"]);
  const deliveryCounts = isRecord(value.deliveryCounts)
    ? Object.fromEntries(
        Object.entries(value.deliveryCounts)
          .filter(([state]) => deliveryStates.has(state))
          .map(([state, amount]) => [state, count(amount)]),
      )
    : {};
  const failedInbound = Array.isArray(value.failedInbound)
    ? value.failedInbound.slice(0, 20).map((entry) => ({
        id: "redacted",
        attempts: isRecord(entry) ? count(entry.attempts) : 0,
        lastError: "Retry failed",
      }))
    : [];
  const recentDeliveryFailures = Array.isArray(value.recentDeliveryFailures)
    ? value.recentDeliveryFailures.slice(0, 10).flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.state !== "string" || !deliveryStates.has(entry.state))
          return [];
        const at = timestamp(entry.at);
        if (at === undefined) return [];
        const errorCode =
          typeof entry.errorCode === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(entry.errorCode)
            ? entry.errorCode
            : undefined;
        return [
          {
            messageId: "redacted",
            chatId: "redacted",
            state: entry.state,
            at,
            ...(errorCode ? { errorCode } : {}),
            errorMessage: "Delivery failed",
          },
        ];
      })
    : [];
  const heldReplies = Array.isArray(value.heldReplies)
    ? value.heldReplies.slice(0, 100).map((entry) => ({
        chatId: "redacted",
        count: isRecord(entry) ? count(entry.count) : 0,
        oldestHeldAt: isRecord(entry) ? timestamp(entry.oldestHeldAt) || 0 : 0,
      }))
    : [];
  const lastInboundAt = timestamp(value.lastInboundAt);
  const lastRejectedAt = timestamp(value.lastRejectedAt);
  return {
    ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
    rejectedWebhooks: count(value.rejectedWebhooks),
    ...(lastRejectedAt === undefined ? {} : { lastRejectedAt }),
    ...(count(value.rejectedWebhooks) > 0
      ? { lastRejectedReason: "Webhook authentication rejected" }
      : {}),
    pendingInbound: count(value.pendingInbound),
    failedInbound,
    deliveryCounts,
    recentDeliveryFailures,
    heldReplies,
  };
}

async function addChannel(gateway: Gateway, request: AddChannelRequest) {
  const securityMode = request.securityMode || "pairing";
  switch (request.type) {
    case "telegram":
      return gateway.addTelegramChannel(
        request.name,
        request.botToken!,
        {
          groupRoutingMode: request.groupRoutingMode,
          allowedGroupChatIds: request.telegramAllowedGroupChatIds,
        },
        securityMode,
      );
    case "discord":
      return gateway.addDiscordChannel(
        request.name,
        request.botToken!,
        request.applicationId!,
        request.guildIds,
        request.discordSupervisor as Parameters<Gateway["addDiscordChannel"]>[4],
        securityMode,
      );
    case "slack":
      return gateway.addSlackChannel(
        request.name,
        request.botToken!,
        request.appToken!,
        request.signingSecret,
        request.progressRelayMode,
        securityMode,
      );
    case "whatsapp":
      return gateway.addWhatsAppChannel(
        request.name,
        request.allowedNumbers,
        securityMode,
        request.selfChatMode ?? true,
        request.responsePrefix ?? "🤖",
        {
          ambientMode: request.ambientMode,
          silentUnauthorized: request.silentUnauthorized,
          ingestNonSelfChatsInSelfChatMode: request.ingestNonSelfChatsInSelfChatMode,
          trustedGroupMemoryOptIn: request.trustedGroupMemoryOptIn,
          sendReadReceipts: request.sendReadReceipts,
          deduplicationEnabled: request.deduplicationEnabled,
          groupRoutingMode: request.groupRoutingMode,
        },
      );
    case "imessage":
      return gateway.addImessageChannel(
        request.name,
        request.cliPath,
        request.dbPath,
        request.allowedContacts,
        securityMode,
        request.dmPolicy,
        request.groupPolicy,
        {
          ambientMode: request.ambientMode,
          silentUnauthorized: request.silentUnauthorized,
          captureSelfMessages: request.captureSelfMessages,
        },
      );
    case "signal":
      return gateway.addSignalChannel(
        request.name,
        request.phoneNumber!,
        request.dataDir,
        securityMode,
        request.mode,
        request.trustMode,
        request.dmPolicy,
        request.groupPolicy,
        request.allowedNumbers,
        request.sendReadReceipts,
        request.sendTypingIndicators,
      );
    case "mattermost":
      return gateway.addMattermostChannel(
        request.name,
        request.mattermostServerUrl!,
        request.mattermostToken!,
        request.mattermostTeamId,
        securityMode,
      );
    case "matrix":
      return gateway.addMatrixChannel(
        request.name,
        request.matrixHomeserver!,
        request.matrixUserId!,
        request.matrixAccessToken!,
        request.matrixDeviceId,
        request.matrixRoomIds,
        securityMode,
      );
    case "twitch":
      return gateway.addTwitchChannel(
        request.name,
        request.twitchUsername!,
        request.twitchOauthToken!,
        request.twitchChannels || [],
        request.twitchAllowWhispers ?? false,
        securityMode,
      );
    case "line":
      return gateway.addLineChannel(
        request.name,
        request.lineChannelAccessToken!,
        request.lineChannelSecret!,
        request.lineWebhookPort,
        securityMode,
      );
    case "bluebubbles":
      return gateway.addBlueBubblesChannel(
        request.name,
        request.blueBubblesServerUrl!,
        request.blueBubblesPassword!,
        request.blueBubblesWebhookPort,
        request.blueBubblesAllowedContacts,
        securityMode,
        {
          ambientMode: request.ambientMode,
          silentUnauthorized: request.silentUnauthorized,
          captureSelfMessages: request.captureSelfMessages,
          webhookSecret: request.blueBubblesWebhookSecret,
        },
      );
    case "googlechat":
      return gateway.addGoogleChatChannel(
        request.name,
        request.serviceAccountKeyPath!,
        request.projectId,
        request.webhookPort,
        request.webhookPath,
        request.webhookSecret,
        securityMode,
      );
    case "feishu":
      return gateway.addFeishuChannel(
        request.name,
        request.feishuAppId!,
        request.feishuAppSecret!,
        request.feishuVerificationToken,
        request.feishuEncryptKey,
        request.webhookPort,
        request.webhookPath,
        securityMode,
      );
    case "wecom":
      return gateway.addWeComChannel(
        request.name,
        request.wecomCorpId!,
        request.wecomAgentId!,
        request.wecomSecret!,
        request.wecomToken!,
        request.wecomEncodingAESKey,
        request.webhookPort,
        request.webhookPath,
        securityMode,
      );
    case "whatsapp_cloud":
      return gateway.addWhatsAppCloudChannel(
        request.name,
        {
          phoneNumberId: request.whatsappCloudPhoneNumberId!,
          accessToken: request.whatsappCloudAccessToken!,
          appSecret: request.whatsappCloudAppSecret!,
          verifyToken: request.whatsappCloudVerifyToken!,
          fallbackTemplateName: request.whatsappCloudFallbackTemplateName,
          fallbackTemplateLanguage: request.whatsappCloudFallbackTemplateLanguage,
          webhookPort: request.webhookPort,
          webhookPath: request.webhookPath,
        },
        securityMode,
      );
    case "twilio_sms":
      return gateway.addTwilioSmsChannel(
        request.name,
        {
          accountSid: request.twilioAccountSid!,
          authToken: request.twilioAuthToken!,
          fromNumber: request.twilioFromNumber,
          messagingServiceSid: request.twilioMessagingServiceSid,
          webhookPublicUrl: request.twilioWebhookPublicUrl!,
          webhookPort: request.webhookPort,
          webhookPath: request.webhookPath,
          statusPath: request.twilioStatusPath,
        },
        securityMode,
      );
    case "x":
      return gateway.addXChannel(
        request.name,
        {
          commandPrefix: request.xCommandPrefix,
          allowedAuthors: request.xAllowedAuthors,
          pollIntervalSec: request.xPollIntervalSec,
          fetchCount: request.xFetchCount,
          outboundEnabled: request.xOutboundEnabled ?? false,
        },
        securityMode,
      );
    case "email":
      return gateway.addEmailChannel(
        request.name,
        request.emailAddress,
        request.emailPassword,
        request.emailImapHost,
        request.emailSmtpHost,
        request.emailDisplayName,
        request.emailAllowedSenders,
        request.emailSubjectFilter,
        "open",
        {
          protocol: request.emailProtocol,
          authMethod: request.emailAuthMethod,
          oauthProvider: request.emailOauthProvider,
          oauthClientId: request.emailOauthClientId,
          oauthClientSecret: request.emailOauthClientSecret,
          oauthTenant: request.emailOauthTenant,
          accessToken: request.emailAccessToken,
          refreshToken: request.emailRefreshToken,
          tokenExpiresAt: request.emailTokenExpiresAt,
          scopes: request.emailScopes,
          imapPort: request.emailImapPort,
          smtpPort: request.emailSmtpPort,
          loomBaseUrl: request.emailLoomBaseUrl,
          loomAccessToken: request.emailLoomAccessToken,
          loomIdentity: request.emailLoomIdentity,
          loomMailboxFolder: request.emailLoomMailboxFolder,
          loomPollInterval: request.emailLoomPollInterval,
        },
      );
    default:
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "This channel setup is not available through the current gateway API.",
        501,
      );
  }
}

export function createBrowserIntegrationDefinitions(
  options: BrowserIntegrationMethodOptions = {},
): BrowserDesktopDefinitions {
  const registry = options.skillRegistry || getSkillRegistry();
  const loader = options.skillLoader || getCustomSkillLoader();
  const accounts = options.managedAccounts || ManagedAccountManager;
  const channelCredentialStorageAvailable =
    options.channelCredentialStorageAvailable ||
    (() => {
      try {
        if (
          SecureSettingsRepository.isInitialized() &&
          !SecureSettingsRepository.getInstance().refusesWrites()
        ) {
          return true;
        }
      } catch {
        // Continue to the OS keychain check; the repository can be initialized during host startup.
      }
      try {
        const storage = getSafeStorage();
        return storage?.isEncryptionAvailable() === true;
      } catch {
        return false;
      }
    });
  const installJobs = new Map<string, SkillInstallJob>();
  const whatsAppChannelBySession = new Map<string, string>();
  const whatsAppOwnerByChannel = new Map<string, string>();
  const revisionSalt = randomBytes(32);
  const bindWhatsAppSession = (sessionId: string, channelId: string) => {
    const previousOwner = whatsAppOwnerByChannel.get(channelId);
    if (previousOwner && previousOwner !== sessionId) {
      whatsAppChannelBySession.delete(previousOwner);
    }
    whatsAppChannelBySession.delete(sessionId);
    whatsAppChannelBySession.set(sessionId, channelId);
    whatsAppOwnerByChannel.set(channelId, sessionId);
    while (whatsAppChannelBySession.size > 128) {
      const oldestSession = whatsAppChannelBySession.keys().next().value;
      if (!oldestSession) break;
      const oldestChannelId = whatsAppChannelBySession.get(oldestSession);
      whatsAppChannelBySession.delete(oldestSession);
      if (oldestChannelId && whatsAppOwnerByChannel.get(oldestChannelId) === oldestSession) {
        whatsAppOwnerByChannel.delete(oldestChannelId);
      }
    }
  };

  const setInstallProgress = (
    owner: string,
    status: SkillInstallProgress["status"],
    progress: unknown,
  ) => {
    installJobs.set(owner, {
      ...safeSkillProgress(status, progress),
      owner,
      updatedAt: Date.now(),
    });
    while (installJobs.size > 128) {
      const oldestFinished = [...installJobs.entries()]
        .filter(([, job]) => job.status === "completed" || job.status === "failed")
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldestFinished) break;
      installJobs.delete(oldestFinished[0]);
    }
  };

  const installSkill = async (
    owner: string,
    run: (
      progress: (status: SkillInstallProgress["status"], value: unknown) => void,
    ) => ReturnType<SkillRegistryPort["install"]>,
  ) => {
    const current = installJobs.get(owner);
    if (current && current.status !== "completed" && current.status !== "failed") {
      throw new WebApplicationError(
        "CONFLICT",
        "A skill install is already running in this browser session.",
        409,
      );
    }
    if (
      installJobs.size >= 128 &&
      ![...installJobs.values()].some(
        (job) => job.status === "completed" || job.status === "failed",
      )
    ) {
      throw new WebApplicationError(
        "RATE_LIMITED",
        "The host is handling too many skill installs. Try again shortly.",
        429,
      );
    }
    setInstallProgress(owner, "starting", 0);
    try {
      const result = await run((status, progress) => setInstallProgress(owner, status, progress));
      if (result.success) {
        await loader.initialize();
        await loader.reloadSkills();
        loader.clearEligibilityCache();
      }
      setInstallProgress(owner, result.success ? "completed" : "failed", result.success ? 100 : 0);
      return safeSkillInstallResult(result);
    } catch {
      setInstallProgress(owner, "failed", 0);
      return {
        success: false,
        error: "The host could not install this skill. Check the source and try again.",
        security: { state: "failed", summary: "Host security review could not complete." },
      };
    }
  };

  const definitions: BrowserDesktopDefinitions = {
    installSkillFromRegistry: definition(
      async ([skillId, version], context) =>
        installSkill(context.sessionId, (progress) =>
          registry.install(
            skillId as string,
            version as string | undefined,
            (state: RegistryInstallProgress) =>
              progress(state.status === "extracting" ? "checking" : state.status, state.progress),
          ),
        ),
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 2,
        validate: (args) => [
          parseString(args[0], 256),
          args[1] === undefined
            ? undefined
            : parseSchema(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/), args[1]),
        ],
      },
    ),
    installSkillFromClawHub: definition(
      ([identifier], context) =>
        installSkill(context.sessionId, async (progress) => {
          progress("downloading", 10);
          return registry.installFromClawHub(identifier as string);
        }),
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([identifier]) => {
          const value = parseString(identifier, 2048);
          if (/^https?:\/\//i.test(value)) {
            let url: URL;
            try {
              url = new URL(value);
            } catch {
              return invalidRequest();
            }
            if (
              !["clawhub.ai", "www.clawhub.ai"].includes(url.hostname.toLowerCase()) ||
              (url.protocol !== "https:" && url.protocol !== "http:") ||
              url.username ||
              url.password
            ) {
              return invalidRequest();
            }
          } else if (!/^(?:clawhub:)?[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/i.test(value)) {
            return invalidRequest();
          }
          return [value];
        },
      },
    ),
    installSkillFromUrl: definition(
      ([source], context) =>
        installSkill(context.sessionId, async (progress) => {
          progress("downloading", 10);
          return registry.installFromUrl(source as string);
        }),
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([source]) => {
          const url = parseSchema(z.string().url().max(2048), source);
          const parsed = new URL(url);
          if (
            (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
            parsed.username ||
            parsed.password
          ) {
            return invalidRequest();
          }
          return [url];
        },
      },
    ),
    installSkillFromGit: definition(
      ([source], context) =>
        installSkill(context.sessionId, async (progress) => {
          progress("downloading", 10);
          return registry.installFromGit(source as string);
        }),
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([source]) => {
          const value = parseString(source, 2048);
          if (/^github:/i.test(value)) {
            if (!/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(value))
              return invalidRequest();
            return [value];
          }
          let url: URL;
          try {
            url = new URL(value);
          } catch {
            return invalidRequest();
          }
          if (
            url.protocol !== "https:" ||
            !["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname.toLowerCase()) ||
            url.username ||
            url.password ||
            !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/[A-Za-z0-9_./-]*)?$/.test(
              url.pathname,
            )
          )
            return invalidRequest();
          return [value];
        },
      },
    ),
    getSkillInstallProgress: definition(
      (_args, context) => {
        const job = installJobs.get(context.sessionId);
        if (!job || Date.now() - job.updatedAt > 10 * 60_000) return null;
        return { status: job.status, progress: job.progress, message: job.message };
      },
      { minArgs: 0, maxArgs: 0 },
    ),
    uninstallSkill: definition(
      ([skillId]) => {
        const result = registry.uninstall(skillId as string);
        if (result.success)
          return loader
            .initialize()
            .then(() => loader.reloadSkills())
            .then(() => result);
        return { success: false, error: "The host could not remove this skill." };
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([skillId]) => [parseString(skillId, 128)],
      },
    ),
    listManagedAccounts: definition(
      ([filters]) => {
        const parsed = filters === undefined ? {} : parseSchema(managedAccountListSchema, filters);
        const results = accounts.list(parsed).slice(0, ACCOUNT_MAX);
        return { accounts: results.map((account) => publicAccount(account, accounts)) };
      },
      { minArgs: 0, maxArgs: 1, validate: (args) => [args[0]] },
    ),
    getManagedAccount: definition(
      ([accountId]) => {
        const account = accounts.getById(accountId as string);
        return { account: account ? publicAccount(account, accounts) : null };
      },
      {
        minArgs: 1,
        maxArgs: 1,
        validate: ([accountId]) => [parseString(accountId, 180)],
      },
    ),
    upsertManagedAccount: definition(
      ([rawInput]) => {
        const input = parseSchema(
          managedAccountUpsertSchema,
          rawInput,
        ) as UpsertManagedAccountInput;
        const account = accounts.upsert(input);
        return { account: publicAccount(account, accounts) };
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: parseSingleArg(managedAccountUpsertSchema),
      },
    ),
    removeManagedAccount: definition(
      ([accountId]) => ({ removed: accounts.remove(accountId as string) }),
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([accountId]) => [parseString(accountId, 180)],
      },
    ),
  };

  if (options.channelGateway) {
    const gateway = options.channelGateway;
    definitions.getGatewayChannels = definition(
      async () => boundedGatewayChannels(await gateway.getChannels()),
      { minArgs: 0, maxArgs: 0 },
    );
    definitions.getGatewayChangeSignal = definition(
      async ([rawRequest], context) => {
        const { workspaceId } = rawRequest as { workspaceId?: string };
        if (workspaceId) {
          if (!options.authorizeWorkspaceRead) {
            throw new WebApplicationError(
              "FORBIDDEN",
              "Workspace access is not authorized on this host.",
              403,
            );
          }
          try {
            await options.authorizeWorkspaceRead(workspaceId, context.sessionId);
          } catch {
            throw new WebApplicationError(
              "FORBIDDEN",
              "Workspace access is not authorized on this host.",
              403,
            );
          }
        }
        // Gateway channels are app-global today; workspaceId narrows the caller's authorization context only.
        const channels = (await gateway.getChannels()).slice(0, MAX_GATEWAY_SIGNAL_CHANNELS);
        return Promise.all(
          channels.map(async (channel) => {
            let users: unknown[] = [];
            try {
              users = (await gateway.getChannelUsers(channel.id)).slice(
                0,
                MAX_GATEWAY_SIGNAL_USERS,
              );
            } catch {
              users = [{ unavailable: true }];
            }
            const userState = users.map((user) => {
              if (!isRecord(user)) return null;
              return {
                id: typeof user.id === "string" ? user.id.slice(0, 180) : "",
                channelUserId:
                  typeof user.channelUserId === "string" ? user.channelUserId.slice(0, 180) : "",
                allowed: user.allowed === true,
                lastSeenAt:
                  typeof user.lastSeenAt === "number" && Number.isFinite(user.lastSeenAt)
                    ? user.lastSeenAt
                    : 0,
              };
            });
            const digestInput = JSON.stringify({
              channel: publicGatewayChannel(channel),
              enabled: channel.enabled === true,
              status: typeof channel.status === "string" ? channel.status.slice(0, 40) : "unknown",
              securityMode: channel.securityConfig?.mode || "unknown",
              updatedAt: typeof channel.updatedAt === "number" ? channel.updatedAt : 0,
              users: userState,
            });
            return {
              channelId: channel.id,
              channelType: channel.type,
              revision: createHash("sha256")
                .update(revisionSalt)
                .update(digestInput)
                .digest("hex")
                .slice(0, 32),
            };
          }),
        );
      },
      { minArgs: 1, maxArgs: 1, validate: ([request]) => [parseGatewaySignalRequest(request)] },
    );
    definitions.addGatewayChannel = definition(
      async ([rawRequest], context) => {
        if (!channelCredentialStorageAvailable()) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "This host cannot save channel credentials because protected credential storage is unavailable.",
            501,
          );
        }
        try {
          const channel = await addChannel(gateway, rawRequest as AddChannelRequest);
          if (channel.type === "whatsapp") {
            bindWhatsAppSession(context.sessionId, channel.id);
            // Match the desktop connect flow: begin pairing, but never send a message or expose auth state in the channel DTO.
            void gateway.enableWhatsAppWithQRForwarding(channel.id).catch(() => undefined);
            return publicChannel({ ...channel, enabled: true, status: "connecting" });
          }
          return publicChannel(channel);
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([request]) => [parseStrictAddChannel(request)],
      },
    );
    definitions.updateGatewayChannel = definition(
      async ([rawRequest]) => {
        const request = rawRequest as z.infer<typeof channelUpdateSchema>;
        const current = await gateway.getChannel(request.id);
        if (!current)
          throw new WebApplicationError("NOT_FOUND", "The channel is unavailable.", 404);
        if (current.configReadError) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Channel credentials cannot be read by this host.",
            501,
          );
        }
        if (request.config !== undefined && !channelCredentialStorageAvailable()) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "This host cannot update channel configuration because protected credential storage is unavailable.",
            501,
          );
        }
        const config =
          request.config === undefined
            ? undefined
            : parseChannelConfigUpdate(current.type, request.config);
        try {
          await gateway.updateChannel(request.id, {
            ...(request.name === undefined ? {} : { name: request.name }),
            ...(request.securityMode === undefined
              ? {}
              : { securityConfig: { ...current.securityConfig, mode: request.securityMode } }),
            ...(config === undefined ? {} : { config: { ...current.config, ...config } }),
          });
          return { updated: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: parseSingleArg(channelUpdateSchema),
      },
    );
    definitions.removeGatewayChannel = definition(
      async ([channelId]) => {
        try {
          await gateway.removeChannel(channelId as string);
          for (const [sessionId, boundChannelId] of whatsAppChannelBySession) {
            if (boundChannelId === channelId) {
              whatsAppChannelBySession.delete(sessionId);
              whatsAppOwnerByChannel.delete(boundChannelId);
            }
          }
          return { removed: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.enableGatewayChannel = definition(
      async ([channelId], context) => {
        const channel = await gateway.getChannel(channelId as string);
        if (!channel)
          throw new WebApplicationError("NOT_FOUND", "The channel is unavailable.", 404);
        if (channel.configReadError) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Channel credentials cannot be read by this host.",
            501,
          );
        }
        try {
          if (channel.type === "whatsapp") {
            bindWhatsAppSession(context.sessionId, channel.id);
            await gateway.enableWhatsAppWithQRForwarding(channel.id);
          } else {
            await gateway.enableChannel(channel.id);
          }
          return { enabled: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.disableGatewayChannel = definition(
      async ([channelId]) => {
        try {
          await gateway.disableChannel(channelId as string);
          return { disabled: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.testGatewayChannel = definition(
      async ([channelId]) => {
        const channel = await gateway.getChannel(channelId as string);
        if (!channel)
          throw new WebApplicationError("NOT_FOUND", "The channel is unavailable.", 404);
        if (channel.configReadError) {
          return { success: false, error: "Channel credentials cannot be read by this host." };
        }
        try {
          const result = await gateway.testChannel(channel.id);
          return {
            success: result.success,
            ...(result.success && result.botUsername
              ? { botUsername: result.botUsername.slice(0, 120) }
              : {}),
            ...(result.success
              ? {}
              : { error: "The host could not verify this channel configuration." }),
          };
        } catch {
          return { success: false, error: "The host could not verify this channel configuration." };
        }
      },
      { minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.getGatewayChannelHealth = definition(
      async ([channelId]) => {
        const channel = await gateway.getChannel(channelId as string);
        if (!channel) return null;
        try {
          const result = await gateway.getChannelHealth(channelId as string);
          if (!result) return null;
          return {
            status: typeof result.status === "string" ? result.status.slice(0, 40) : "unknown",
            health: safeChannelHealth(result.health),
          };
        } catch {
          return null;
        }
      },
      { minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.getGatewayUsers = definition(
      async ([channelId]) => {
        try {
          const users = await gateway.getChannelUsers(channelId as string);
          return users.slice(0, 500).map((user) => ({
            id: user.id,
            channelId: user.channelId,
            channelUserId: user.channelUserId,
            displayName: user.displayName?.slice(0, 160),
            username: user.username?.slice(0, 160),
            allowed: user.allowed,
            lastSeenAt: user.lastSeenAt,
          }));
        } catch {
          throw new WebApplicationError(
            "INTERNAL_ERROR",
            "The host could not load channel users.",
            500,
          );
        }
      },
      { minArgs: 1, maxArgs: 1, validate: ([id]) => [parseUuid(id)] },
    );
    definitions.grantGatewayUserAccess = definition(
      async ([request]) => {
        const parsed = parseSchema(
          z
            .object({
              channelId: z.string().uuid(),
              userId: z.string().trim().min(1).max(100),
              displayName: z.string().max(500).optional(),
            })
            .strict(),
          request,
        );
        try {
          await gateway.grantUserAccess(parsed.channelId, parsed.userId, parsed.displayName);
          return { granted: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1 },
    );
    definitions.revokeGatewayUserAccess = definition(
      async ([request]) => {
        const parsed = parseSchema(
          z
            .object({ channelId: z.string().uuid(), userId: z.string().trim().min(1).max(100) })
            .strict(),
          request,
        );
        try {
          await gateway.revokeUserAccess(parsed.channelId, parsed.userId);
          return { revoked: true };
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1 },
    );
    definitions.generateGatewayPairing = definition(
      async ([request]) => {
        const parsed = parseSchema(
          z
            .object({
              channelId: z.string().uuid(),
              userId: z.string().max(100).optional(),
              displayName: z.string().max(500).optional(),
            })
            .strict(),
          request,
        );
        try {
          const code = await gateway.generatePairingCode(
            parsed.channelId,
            parsed.userId,
            parsed.displayName,
          );
          return typeof code === "string" ? code.slice(0, 64) : null;
        } catch (error) {
          throw safeGatewayFailure(error);
        }
      },
      { mutation: true, minArgs: 1, maxArgs: 1 },
    );
    definitions.getWhatsAppInfo = definition(
      async (_args, context) => {
        let channelId = whatsAppChannelBySession.get(context.sessionId);
        if (!channelId) {
          // This gateway supports one WhatsApp channel, allowing a refreshed settings page to resume polling.
          const channels = await gateway.getChannels();
          const channel = channels.find((item) => item.type === "whatsapp");
          if (channel) {
            const owner = whatsAppOwnerByChannel.get(channel.id);
            if (owner && owner !== context.sessionId) return { status: channel.status };
            channelId = channel.id;
            bindWhatsAppSession(context.sessionId, channelId);
          }
        }
        if (!channelId) return {};
        const channel = await gateway.getChannel(channelId);
        if (!channel || channel.type !== "whatsapp" || channel.configReadError) return {};
        try {
          const snapshot = await gateway.getWhatsAppInfo();
          const status = ["disconnected", "connecting", "connected", "error"].includes(
            snapshot.status || "",
          )
            ? snapshot.status
            : channel.status;
          return {
            ...(typeof snapshot.qrCode === "string" && snapshot.qrCode.length <= 4096
              ? { qrCode: snapshot.qrCode }
              : {}),
            ...(typeof snapshot.phoneNumber === "string"
              ? { phoneNumber: snapshot.phoneNumber.slice(0, 80) }
              : {}),
            ...(typeof status === "string" ? { status: status.slice(0, 40) } : {}),
          };
        } catch {
          return { status: channel.status };
        }
      },
      { minArgs: 0, maxArgs: 0 },
    );
    definitions.whatsAppLogout = definition(
      async (_args, context) => {
        const channelId = whatsAppChannelBySession.get(context.sessionId);
        if (!channelId || whatsAppOwnerByChannel.get(channelId) !== context.sessionId)
          throw new WebApplicationError("NOT_FOUND", "The WhatsApp channel is unavailable.", 404);
        const channel = await gateway.getChannel(channelId);
        if (!channel || channel.type !== "whatsapp" || channel.configReadError) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "WhatsApp credentials cannot be read by this host.",
            501,
          );
        }
        try {
          await gateway.whatsAppLogout();
          return { loggedOut: true };
        } catch {
          throw new WebApplicationError(
            "INTERNAL_ERROR",
            "The host could not log out from WhatsApp.",
            500,
          );
        }
      },
      { mutation: true, minArgs: 0, maxArgs: 0 },
    );
  }

  return definitions;
}
