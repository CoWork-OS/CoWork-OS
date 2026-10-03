import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ManagedAccountRecord,
  UpsertManagedAccountInput,
} from "../../../electron/accounts/managed-account-manager";
import { ManagedAccountManager } from "../../../electron/accounts/managed-account-manager";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";
import { createBrowserIntegrationDefinitions } from "../browser-integration-methods";

const SESSION_ID = "browser-session-1";

function rpcFor(definitions: ReturnType<typeof createBrowserIntegrationDefinitions>) {
  return new BrowserDesktopRpcService(definitions).methods();
}

async function invoke(
  methods: ReturnType<BrowserDesktopRpcService["methods"]>,
  name: string,
  args: unknown[] = [],
  sessionId = SESSION_ID,
) {
  const method = methods[`desktop.${name}`];
  if (!method) throw new Error(`Missing method ${name}`);
  const params = method.validateParams?.({ args });
  return method.handler(
    {
      audience: "web",
      identity: { profileId: "synthetic-profile" },
      sessionId,
      operationKey: `test-${name}-${randomUUID()}`,
    } as never,
    params,
  );
}

function accountManager() {
  let saved: ManagedAccountRecord | undefined;
  return {
    list: vi.fn(() => (saved ? [saved] : [])),
    getById: vi.fn(() => saved),
    upsert: vi.fn((input: UpsertManagedAccountInput) => {
      saved = {
        id: input.id || "synthetic-account",
        provider: input.provider || "synthetic-provider",
        label: input.label || "Synthetic account",
        status: input.status || "draft",
        signupUrl: input.signupUrl,
        dashboardUrl: input.dashboardUrl,
        docsUrl: input.docsUrl,
        secrets: {
          ...saved?.secrets,
          ...(input.secrets as Record<string, string> | undefined),
        },
        notes: "private account note",
        metadata: { private: "account metadata" },
        createdAt: 1,
        updatedAt: 2,
      };
      return saved;
    }),
    remove: vi.fn(() => true),
    toPublicView: ManagedAccountManager.toPublicView,
  };
}

function fakeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: "telegram",
    name: "Synthetic Telegram",
    enabled: false,
    config: { botToken: "synthetic-channel-secret" },
    securityConfig: { mode: "pairing" as const },
    status: "disconnected",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("browser integration desktop methods", () => {
  it("stores managed account credentials without returning secret values or private metadata", async () => {
    const manager = accountManager();
    const methods = rpcFor(
      createBrowserIntegrationDefinitions({ managedAccounts: manager as never }),
    );
    const secret = "synthetic-account-secret";

    const result = await invoke(methods, "upsertManagedAccount", [
      {
        provider: "Example Provider",
        label: "Synthetic",
        dashboardUrl:
          "https://private-user:private-pass@example.test/account?token=synthetic-url-secret",
        secrets: { apiToken: secret },
      },
    ]);

    expect(result).toMatchObject({
      account: { provider: "Example Provider", secretKeys: ["apiToken"], secretCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private account note");
    expect(JSON.stringify(result)).not.toContain("account metadata");
    expect(JSON.stringify(result)).not.toContain("private-user");
    expect(JSON.stringify(result)).not.toContain("private-pass");
    expect(JSON.stringify(result)).not.toContain("synthetic-url-secret");
    expect(JSON.stringify(await invoke(methods, "listManagedAccounts"))).not.toContain(secret);
    expect(() =>
      methods["desktop.upsertManagedAccount"].validateParams?.({
        args: [{ provider: "example", includeSecrets: true }],
      }),
    ).toThrow();
    expect(() =>
      methods["desktop.upsertManagedAccount"].validateParams?.({
        args: [{ provider: "example", secrets: { "bad key": secret } }],
      }),
    ).toThrow();
  });

  it("keeps skill install progress session-owned and removes source paths and prompts from results", async () => {
    const install = vi.fn(
      async (_id: string, _version: string | undefined, onProgress?: (progress: never) => void) => {
        onProgress?.({
          skillId: "synthetic",
          status: "downloading",
          progress: 35,
          message: "private source url",
        } as never);
        onProgress?.({
          skillId: "synthetic",
          status: "extracting",
          progress: 75,
          message: "private source url",
        } as never);
        return {
          success: true,
          skill: {
            id: "synthetic-skill",
            name: "Synthetic skill",
            description: "safe description",
            prompt: "private skill prompt",
            filePath: "/private/skills/synthetic/SKILL.md",
            category: "test",
            enabled: true,
            type: "custom",
            source: "managed",
          },
        } as never;
      },
    );
    const loader = {
      initialize: vi.fn(async () => undefined),
      reloadSkills: vi.fn(async () => undefined),
      clearEligibilityCache: vi.fn(),
    };
    const methods = rpcFor(
      createBrowserIntegrationDefinitions({
        skillRegistry: {
          install,
          installFromClawHub: vi.fn(),
          installFromUrl: vi.fn(),
          installFromGit: vi.fn(),
          uninstall: vi.fn(),
        } as never,
        skillLoader: loader as never,
      }),
    );

    const result = await invoke(methods, "installSkillFromRegistry", ["synthetic-skill", "1.2.3"]);
    const progress = await invoke(methods, "getSkillInstallProgress");
    const otherSessionProgress = await invoke(
      methods,
      "getSkillInstallProgress",
      [],
      "another-session",
    );

    expect(result).toMatchObject({ success: true, skill: { id: "synthetic-skill", prompt: "" } });
    expect(JSON.stringify(result)).not.toContain("private skill prompt");
    expect(JSON.stringify(result)).not.toContain("/private/skills");
    expect(progress).toEqual({ status: "completed", progress: 100, message: "Skill installed" });
    expect(otherSessionProgress).toBeNull();
    expect(loader.reloadSkills).toHaveBeenCalledOnce();
    expect(() =>
      methods["desktop.installSkillFromRegistry"].validateParams?.({
        args: ["synthetic-skill", "1.2.3&token=secret"],
      }),
    ).toThrow();
    expect(() =>
      methods["desktop.installSkillFromGit"].validateParams?.({
        args: ["https://user:password@github.com/example/skill.git"],
      }),
    ).toThrow();
    expect(
      methods["desktop.installSkillFromGit"].validateParams?.({ args: ["github:example/skill"] }),
    ).toEqual(["github:example/skill"]);
  });

  it("redacts channel configs, requires secure storage, and binds WhatsApp snapshots to a browser session", async () => {
    const added = fakeChannel({
      config: {
        botToken: "synthetic-channel-secret",
        groupRoutingMode: "mentionsOrCommands",
        allowedGroupChatIds: ["synthetic-group-id"],
      },
    });
    const whatsapp = fakeChannel({
      id: "00000000-0000-4000-8000-000000000002",
      type: "whatsapp",
      name: "Synthetic WhatsApp",
      config: { allowedNumbers: [], selfChatMode: true },
      status: "connecting",
    });
    const pathChannel = fakeChannel({
      id: "00000000-0000-4000-8000-000000000003",
      type: "signal",
      name: "Synthetic Signal",
      config: { phoneNumber: "+15550000000", dataDir: "/private/signal/data" },
    });
    const urlChannel = fakeChannel({
      id: "00000000-0000-4000-8000-000000000004",
      type: "mattermost",
      name: "Synthetic Mattermost",
      config: {
        token: "synthetic-mattermost-token",
        serverUrl: "https://private-user:private-pass@example.test/api?access_token=url-secret",
      },
    });
    const discordChannel = fakeChannel({
      id: "00000000-0000-4000-8000-000000000005",
      type: "discord",
      name: "Synthetic Discord",
      config: {
        botToken: "synthetic-discord-secret",
        applicationId: "synthetic-application-id",
        guildIds: ["synthetic-guild-id"],
      },
    });
    const emailChannel = fakeChannel({
      id: "00000000-0000-4000-8000-000000000006",
      type: "email",
      name: "Synthetic email",
      config: {
        email: "synthetic@example.test",
        password: "synthetic-email-secret",
        imapPort: 993,
        imapSecure: true,
        smtpPort: 587,
        smtpSecure: true,
        tokenExpiresAt: 123,
      },
    });
    const gateway = {
      addTelegramChannel: vi.fn(async () => added),
      addWhatsAppChannel: vi.fn(async () => whatsapp),
      getChannels: vi.fn(async () => [
        whatsapp,
        added,
        pathChannel,
        urlChannel,
        discordChannel,
        emailChannel,
      ]),
      getChannel: vi.fn(async (id: string) =>
        [whatsapp, added, pathChannel, urlChannel, discordChannel, emailChannel].find(
          (channel) => channel.id === id,
        ),
      ),
      updateChannel: vi.fn(async () => undefined),
      enableWhatsAppWithQRForwarding: vi.fn(async () => undefined),
      getWhatsAppInfo: vi.fn(async () => ({
        qrCode: "synthetic-qr-credential",
        phoneNumber: "+15550000000",
        status: "connecting",
      })),
      getChannelUsers: vi.fn(async () => []),
      getChannelHealth: vi.fn(async () => ({
        status: "connected",
        health: {
          rejectedWebhooks: 1,
          lastRejectedReason: "synthetic-webhook-secret https://example.test/?token=private",
          pendingInbound: 1,
          failedInbound: [{ id: "synthetic-message-id", attempts: 2, lastError: "private token" }],
          deliveryCounts: { failed: 1, token: 99 },
          recentDeliveryFailures: [
            {
              messageId: "synthetic-message-id",
              chatId: "synthetic-chat-id",
              state: "failed",
              at: 1,
              errorCode: "E_PRIVATE",
              errorMessage: "synthetic-webhook-secret",
            },
          ],
          heldReplies: [{ chatId: "synthetic-chat-id", count: 1, oldestHeldAt: 1 }],
        },
      })),
    };
    const methods = rpcFor(
      createBrowserIntegrationDefinitions({
        channelGateway: gateway as never,
        channelCredentialStorageAvailable: () => true,
      }),
    );

    const channelResult = await invoke(methods, "addGatewayChannel", [
      { type: "telegram", name: "Synthetic Telegram", botToken: "synthetic-channel-secret" },
    ]);
    expect(channelResult).toMatchObject({
      id: added.id,
      type: "telegram",
      name: "Synthetic Telegram",
    });
    expect(JSON.stringify(channelResult)).not.toContain("synthetic-channel-secret");
    expect(JSON.stringify(channelResult)).not.toContain("config");
    const channelList = (await invoke(methods, "getGatewayChannels")) as Array<
      Record<string, unknown>
    >;
    const telegramDto = channelList.find((channel) => channel.id === added.id)!;
    expect(telegramDto).toMatchObject({
      id: added.id,
      type: "telegram",
      securityMode: "pairing",
      credentialConfigured: true,
      config: {
        groupRoutingMode: "mentionsOrCommands",
        allowedGroupChatIds: ["synthetic-group-id"],
      },
    });
    expect(JSON.stringify(telegramDto)).not.toContain("synthetic-channel-secret");
    expect(JSON.stringify(channelList)).not.toContain("/private/signal/data");
    expect(JSON.stringify(channelList)).not.toContain("private-user");
    expect(JSON.stringify(channelList)).not.toContain("private-pass");
    expect(JSON.stringify(channelList)).not.toContain("url-secret");
    expect(channelList.find((channel) => channel.id === urlChannel.id)).toMatchObject({
      config: { serverUrl: "https://example.test/api" },
    });
    expect(channelList.find((channel) => channel.id === discordChannel.id)).toMatchObject({
      credentialConfigured: true,
      config: {
        applicationId: "synthetic-application-id",
        guildIds: ["synthetic-guild-id"],
      },
    });
    expect(
      JSON.stringify(channelList.find((channel) => channel.id === discordChannel.id)),
    ).not.toContain("synthetic-discord-secret");
    expect(channelList.find((channel) => channel.id === emailChannel.id)).toMatchObject({
      credentialConfigured: true,
      config: {
        email: "synthetic@example.test",
        imapPort: 993,
        imapSecure: true,
        smtpPort: 587,
        smtpSecure: true,
        tokenExpiresAt: 123,
      },
    });
    expect(
      JSON.stringify(channelList.find((channel) => channel.id === emailChannel.id)),
    ).not.toContain("synthetic-email-secret");
    expect(() =>
      methods["desktop.updateGatewayChannel"].validateParams?.({
        args: [{ id: added.id, config: { accessToken: "not-a-telegram-field" } }],
      }),
    ).not.toThrow();
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: added.id, config: { accessToken: "not-a-telegram-field" } },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const updated = await invoke(methods, "updateGatewayChannel", [
      { id: added.id, config: { botToken: "synthetic-replacement-secret" } },
    ]);
    expect(updated).toEqual({ updated: true });
    expect(JSON.stringify(updated)).not.toContain("synthetic-replacement-secret");
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: discordChannel.id, config: { applicationId: "synthetic-new-app", guildIds: [] } },
      ]),
    ).resolves.toEqual({ updated: true });
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: emailChannel.id, config: { imapPort: 1993, tokenExpiresAt: 456 } },
      ]),
    ).resolves.toEqual({ updated: true });
    // SEC-16 owner accounts: allowed on every channel type, normalized, and validated.
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: discordChannel.id, config: { ownerUserIds: [" 1234567890 ", "1234567890"] } },
      ]),
    ).resolves.toEqual({ updated: true });
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: discordChannel.id, config: { ownerUserIds: ["has space"] } },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      invoke(methods, "updateGatewayChannel", [
        { id: discordChannel.id, config: { ownerUserIds: "1234567890" } },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const health = await invoke(methods, "getGatewayChannelHealth", [added.id]);
    expect(health).toMatchObject({
      status: "connected",
      health: {
        rejectedWebhooks: 1,
        lastRejectedReason: "Webhook authentication rejected",
        failedInbound: [{ id: "redacted", attempts: 2, lastError: "Retry failed" }],
        deliveryCounts: { failed: 1 },
        recentDeliveryFailures: [
          {
            messageId: "redacted",
            chatId: "redacted",
            errorMessage: "Delivery failed",
          },
        ],
        heldReplies: [{ chatId: "redacted", count: 1 }],
      },
    });
    expect(JSON.stringify(health)).not.toContain("synthetic-webhook-secret");
    expect(JSON.stringify(health)).not.toContain("synthetic-message-id");
    expect(JSON.stringify(health)).not.toContain("synthetic-chat-id");

    await invoke(methods, "addGatewayChannel", [{ type: "whatsapp", name: "Synthetic WhatsApp" }]);
    const info = await invoke(methods, "getWhatsAppInfo");
    expect(info).toEqual({
      qrCode: "synthetic-qr-credential",
      phoneNumber: "+15550000000",
      status: "connecting",
    });
    expect(await invoke(methods, "getWhatsAppInfo", [], "unbound-session")).toEqual({
      status: "connecting",
    });
    expect(gateway.enableWhatsAppWithQRForwarding).toHaveBeenCalledWith(whatsapp.id);

    const blockedGateway = { addTelegramChannel: vi.fn() };
    const blockedMethods = rpcFor(
      createBrowserIntegrationDefinitions({
        channelGateway: blockedGateway as never,
        channelCredentialStorageAvailable: () => false,
      }),
    );
    await expect(
      invoke(blockedMethods, "addGatewayChannel", [
        { type: "telegram", name: "Synthetic Telegram", botToken: "synthetic-channel-secret" },
      ]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(blockedGateway.addTelegramChannel).not.toHaveBeenCalled();
  });

  it("returns bounded redacted gateway revisions and fails closed for unauthorized workspace scope", async () => {
    const channel = fakeChannel();
    let lastSeenAt = 123;
    const gateway = {
      getChannels: vi.fn(async () => [channel]),
      getChannelUsers: vi.fn(async () => [
        {
          id: "private-user-row-id",
          channelId: channel.id,
          channelUserId: "private-channel-user-id",
          displayName: "Private name",
          username: "private-user",
          allowed: true,
          pairingCode: "private-pairing-code",
          lastSeenAt,
        },
      ]),
    };
    const authorizeWorkspaceRead = vi.fn(async () => undefined);
    const methods = rpcFor(
      createBrowserIntegrationDefinitions({
        channelGateway: gateway as never,
        authorizeWorkspaceRead,
      }),
    );

    const first = await invoke(methods, "getGatewayChangeSignal", [{}]);
    const second = await invoke(methods, "getGatewayChangeSignal", [{}]);
    lastSeenAt += 1;
    const afterUserChange = await invoke(methods, "getGatewayChangeSignal", [{}]);
    const scoped = await invoke(methods, "getGatewayChangeSignal", [
      { workspaceId: "00000000-0000-4000-8000-000000000099" },
    ]);

    expect(first).toEqual([
      { channelId: channel.id, channelType: "telegram", revision: expect.any(String) },
    ]);
    expect((first as Array<{ revision: string }>)[0].revision).toBe(
      (second as Array<{ revision: string }>)[0].revision,
    );
    expect((first as Array<{ revision: string }>)[0].revision).not.toBe(
      (afterUserChange as Array<{ revision: string }>)[0].revision,
    );
    expect(scoped).toEqual(afterUserChange);
    expect(authorizeWorkspaceRead).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
      SESSION_ID,
    );
    expect(JSON.stringify(first)).not.toContain("private-channel-user-id");
    expect(JSON.stringify(first)).not.toContain("private-pairing-code");
    expect(() =>
      methods["desktop.getGatewayChangeSignal"].validateParams?.({
        args: [{ workspaceId: "not-a-uuid" }],
      }),
    ).toThrow();

    const noWorkspaceAuth = rpcFor(
      createBrowserIntegrationDefinitions({ channelGateway: gateway as never }),
    );
    await expect(
      invoke(noWorkspaceAuth, "getGatewayChangeSignal", [
        { workspaceId: "00000000-0000-4000-8000-000000000099" },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
