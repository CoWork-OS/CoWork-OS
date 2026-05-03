import { describe, expect, it } from "vitest";
import {
  validateInput,
  WorkspaceCreateSchema,
  TaskCreateSchema,
  TaskWorkspaceUpdateSchema,
  TaskMessageSchema,
  ApprovalResponseSchema,
  GuardrailSettingsSchema,
  ChannelConfigSchema,
  EmailChannelConfigSchema,
  AddEmailChannelSchema,
  AddDiscordChannelSchema,
  AddFeishuChannelSchema,
  AddWeComChannelSchema,
  PersonalityConfigV2Schema,
} from "../validation";
import { z } from "zod";

describe("validateInput", () => {
  const simpleSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it("returns parsed data for valid input", () => {
    const result = validateInput(simpleSchema, { name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("throws on invalid input with error details", () => {
    expect(() => validateInput(simpleSchema, { name: "", age: -1 })).toThrow("Invalid input:");
  });

  it("includes context in error message when provided", () => {
    expect(() => validateInput(simpleSchema, { name: "" }, "user profile")).toThrow(
      "Invalid user profile:",
    );
  });

  it("includes field paths in error message", () => {
    try {
      validateInput(simpleSchema, { name: "ok", age: "not a number" });
    } catch (e: Any) {
      expect(e.message).toContain("age");
    }
  });
});

describe("PersonalityConfigV2Schema", () => {
  it("accepts every communication style value exposed by the Personality UI", () => {
    const result = PersonalityConfigV2Schema.safeParse({
      version: 2,
      style: {
        emojiUsage: "expressive",
        responseLength: "detailed",
        codeCommentStyle: "verbose",
        explanationDepth: "teaching",
        formality: "formal",
        structurePreference: "headers",
        proactivity: "proactive",
        errorHandling: "detailed",
      },
    });

    expect(result.success).toBe(true);
  });

  it("normalizes legacy communication style values before saving", () => {
    const result = PersonalityConfigV2Schema.safeParse({
      version: 2,
      style: {
        codeCommentStyle: "thorough",
        explanationDepth: "minimal",
        structurePreference: "prose",
        errorHandling: "technical",
      },
      contextOverrides: [
        {
          mode: "coding",
          styleOverrides: {
            explanationDepth: "thorough",
            structurePreference: "mixed",
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.style).toMatchObject({
      codeCommentStyle: "verbose",
      explanationDepth: "expert",
      structurePreference: "freeform",
      errorHandling: "detailed",
    });
    expect(result.data.contextOverrides?.[0]?.styleOverrides).toMatchObject({
      explanationDepth: "teaching",
      structurePreference: "structured",
    });
  });
});

describe("WorkspaceCreateSchema", () => {
  it("validates a minimal workspace", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "My Workspace",
      path: "/home/user/workspace",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "",
      path: "/home/user/workspace",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty path", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "Test",
      path: "",
    });
    expect(result.success).toBe(false);
  });

  it("validates with permissions", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "Test",
      path: "/tmp/test",
      permissions: {
        read: true,
        write: false,
        delete: false,
        network: true,
        shell: false,
        unrestrictedFileAccess: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects name exceeding max length", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "x".repeat(501),
      path: "/tmp/test",
    });
    expect(result.success).toBe(false);
  });
});

describe("TaskCreateSchema", () => {
  it("validates with UUID workspaceId", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test Task",
      prompt: "Do something",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("validates with temp workspace ID", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test Task",
      prompt: "Do something",
      workspaceId: "__temp_workspace__",
    });
    expect(result.success).toBe(true);
  });

  it("validates with session temp workspace ID", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test Task",
      prompt: "Do something",
      workspaceId: "__temp_workspace__:session-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid workspaceId", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test Task",
      prompt: "Do something",
      workspaceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = TaskCreateSchema.safeParse({
      title: "",
      prompt: "Do something",
      workspaceId: "__temp_workspace__",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty prompt", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test",
      prompt: "",
      workspaceId: "__temp_workspace__",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional budgetTokens", () => {
    const result = TaskCreateSchema.safeParse({
      title: "Test",
      prompt: "Do it",
      workspaceId: "__temp_workspace__",
      budgetTokens: 50000,
    });
    expect(result.success).toBe(true);
  });
});

describe("TaskWorkspaceUpdateSchema", () => {
  it("validates a task workspace update with a persistent workspace", () => {
    const result = TaskWorkspaceUpdateSchema.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
    });

    expect(result.success).toBe(true);
  });

  it("validates a task workspace update with a temp workspace", () => {
    const result = TaskWorkspaceUpdateSchema.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "__temp_workspace__:session-123",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid task ID", () => {
    const result = TaskWorkspaceUpdateSchema.safeParse({
      taskId: "not-a-task-id",
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
    });

    expect(result.success).toBe(false);
  });
});

describe("TaskMessageSchema", () => {
  it("accepts a quoted assistant message payload", () => {
    const result = TaskMessageSchema.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Can you revise this?",
      quotedAssistantMessage: {
        eventId: "event-123",
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Here is the earlier assistant reply.",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty quoted assistant message", () => {
    const result = TaskMessageSchema.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Can you revise this?",
      quotedAssistantMessage: {
        message: "",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalResponseSchema", () => {
  it("validates correct approval response", () => {
    const result = ApprovalResponseSchema.safeParse({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      approved: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID approvalId", () => {
    const result = ApprovalResponseSchema.safeParse({
      approvalId: "invalid",
      approved: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean approved", () => {
    const result = ApprovalResponseSchema.safeParse({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      approved: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("accepts action-only approval responses", () => {
    const result = ApprovalResponseSchema.safeParse({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      action: "allow_workspace",
    });
    expect(result.success).toBe(true);
  });

  it("rejects responses without approved or action", () => {
    const result = ApprovalResponseSchema.safeParse({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(false);
  });
});

describe("GuardrailSettingsSchema", () => {
  it("validates with all defaults", () => {
    const result = GuardrailSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTokensPerTask).toBe(100000);
      expect(result.data.tokenBudgetEnabled).toBe(true);
      expect(result.data.blockDangerousCommands).toBe(true);
      expect(result.data.maxIterationsPerTask).toBe(50);
      expect(result.data.webSearchMode).toBe("cached");
      expect(result.data.webSearchMaxUsesPerTask).toBe(8);
      expect(result.data.webSearchMaxUsesPerStep).toBe(3);
      expect(result.data.webSearchAllowedDomains).toEqual([]);
      expect(result.data.webSearchBlockedDomains).toEqual([]);
      expect(result.data.autoContinuationEnabled).toBe(true);
      expect(result.data.defaultMaxAutoContinuations).toBe(3);
      expect(result.data.defaultMinProgressScore).toBe(0.25);
      expect(result.data.lifetimeTurnCapEnabled).toBe(true);
      expect(result.data.defaultLifetimeTurnCap).toBe(320);
    }
  });

  it("rejects maxTokensPerTask below minimum", () => {
    const result = GuardrailSettingsSchema.safeParse({ maxTokensPerTask: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects maxIterationsPerTask above maximum", () => {
    const result = GuardrailSettingsSchema.safeParse({ maxIterationsPerTask: 501 });
    expect(result.success).toBe(false);
  });

  it("validates custom blocked patterns", () => {
    const result = GuardrailSettingsSchema.safeParse({
      customBlockedPatterns: ["rm -rf", "DROP TABLE"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range continuation thresholds", () => {
    const result = GuardrailSettingsSchema.safeParse({
      defaultMinProgressScore: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid web search mode values", () => {
    const result = GuardrailSettingsSchema.safeParse({
      webSearchMode: "archive",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative web search usage caps", () => {
    const result = GuardrailSettingsSchema.safeParse({
      webSearchMaxUsesPerTask: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized web search domain lists", () => {
    const result = GuardrailSettingsSchema.safeParse({
      webSearchAllowedDomains: new Array(101).fill("example.com"),
    });
    expect(result.success).toBe(false);
  });

  it("accepts web search usage caps at upper bounds", () => {
    const result = GuardrailSettingsSchema.safeParse({
      webSearchMaxUsesPerTask: 500,
      webSearchMaxUsesPerStep: 100,
    });
    expect(result.success).toBe(true);
  });
});

describe("gateway channel schemas", () => {
  it("validates a Feishu add-channel request", () => {
    const result = AddFeishuChannelSchema.safeParse({
      type: "feishu",
      name: "Feishu Bot",
      feishuAppId: "cli_123",
      feishuAppSecret: "secret_123",
      feishuVerificationToken: "token_123",
      webhookPort: 3980,
      webhookPath: "/feishu/webhook",
    });
    expect(result.success).toBe(true);
  });

  it("validates a WeCom add-channel request", () => {
    const result = AddWeComChannelSchema.safeParse({
      type: "wecom",
      name: "WeCom Bot",
      wecomCorpId: "wx123456",
      wecomAgentId: 1000002,
      wecomSecret: "secret_123",
      wecomToken: "token_123",
      wecomEncodingAESKey: "abcdefghijklmnopqrstuvwxyzABCDEFG1234567890",
      webhookPort: 3981,
      webhookPath: "/wecom/webhook",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid WeCom encoding AES key length", () => {
    const result = AddWeComChannelSchema.safeParse({
      type: "wecom",
      name: "WeCom Bot",
      wecomCorpId: "wx123456",
      wecomAgentId: 1000002,
      wecomSecret: "secret_123",
      wecomToken: "token_123",
      wecomEncodingAESKey: "too-short",
    });
    expect(result.success).toBe(false);
  });
});

describe("EmailChannelConfigSchema", () => {
  it("accepts valid IMAP/SMTP configuration", () => {
    const result = EmailChannelConfigSchema.safeParse({
      protocol: "imap-smtp",
      email: "agent@example.com",
      password: "secret",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
    });

    expect(result.success).toBe(true);
  });

  it("accepts follow-up permission overrides", () => {
    const result = TaskMessageSchema.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Continue with full access.",
      permissionMode: "bypass_permissions",
      shellAccess: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        permissionMode: "bypass_permissions",
        shellAccess: true,
      }),
    );
  });

  it("accepts unknown legacy keys for forward compatibility", () => {
    const result = EmailChannelConfigSchema.safeParse({
      protocol: "imap-smtp",
      email: "agent@example.com",
      password: "secret",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      pluginMetadata: "legacy-plugin-state",
      legacyFlag: true,
    });

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).pluginMetadata).toBe("legacy-plugin-state");
    expect((result.data as Record<string, unknown>).legacyFlag).toBe(true);
  });

  it("requires credentials for IMAP/SMTP mode", () => {
    const result = EmailChannelConfigSchema.safeParse({
      protocol: "imap-smtp",
    });

    expect(result.success).toBe(false);
  });

  it("requires LOOM base URL over HTTPS or localhost", () => {
    const result = EmailChannelConfigSchema.safeParse({
      protocol: "loom",
      loomAccessToken: "token",
      loomBaseUrl: "http://example.com",
    });

    expect(result.success).toBe(false);
  });

  it("validates LOOM mailbox folder characters", () => {
    const result = EmailChannelConfigSchema.safeParse({
      protocol: "loom",
      loomBaseUrl: "http://127.0.0.1:8787",
      loomAccessToken: "token",
      loomMailboxFolder: "INBOX/../Work",
    });

    expect(result.success).toBe(false);
  });
});

describe("AddEmailChannelSchema", () => {
  it("validates IMAP/SMTP add payload using prefixed fields", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailProtocol: "imap-smtp",
      emailAddress: "agent@example.com",
      emailPassword: "secret",
      emailImapHost: "imap.example.com",
      emailSmtpHost: "smtp.example.com",
    });

    expect(result.success).toBe(true);
  });

  it("defaults IMAP/SMTP protocol on add when protocol is omitted", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailAddress: "agent@example.com",
      emailPassword: "secret",
      emailImapHost: "imap.example.com",
      emailSmtpHost: "smtp.example.com",
    });

    expect(result.success).toBe(true);
  });

  it("validates LOOM add payload requiring LOOM fields and optional display alias", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailProtocol: "loom",
      emailLoomBaseUrl: "https://mail.example.com",
      emailLoomAccessToken: "token",
      emailLoomMailboxFolder: "INBOX",
    });

    expect(result.success).toBe(true);
  });

  it("validates LOOM add mailbox folder path characters", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailProtocol: "loom",
      emailLoomBaseUrl: "https://mail.example.com",
      emailLoomAccessToken: "token",
      emailLoomMailboxFolder: "INBOX/../Work",
    });

    expect(result.success).toBe(false);
  });

  it("rejects IMAP/SMTP add payload missing required mapped hosts and credentials", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailProtocol: "imap-smtp",
    });

    expect(result.success).toBe(false);
  });

  it("shares protocol validation behavior with update schema for IMAP/SMTP mode", () => {
    const result = AddEmailChannelSchema.safeParse({
      type: "email",
      name: "Mailbox",
      emailProtocol: "imap-smtp",
      emailAddress: "agent@example.com",
      emailPassword: "secret",
      emailImapHost: "imap.example.com",
    });

    expect(result.success).toBe(false);
  });
});

describe("ChannelConfigSchema", () => {
  it("allows extra keys from future channel plugins", () => {
    const result = ChannelConfigSchema.safeParse({
      selfChatMode: true,
      trustedGroupMemoryOptIn: false,
      pluginVersion: "2.0",
    });

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).pluginVersion).toBe("2.0");
  });

  it("rejects enabled supervisor configs that omit required routing fields", () => {
    const result = ChannelConfigSchema.safeParse({
      supervisor: {
        enabled: true,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("AddDiscordChannelSchema", () => {
  it("rejects enabled supervisor mode without the required automation fields", () => {
    const result = AddDiscordChannelSchema.safeParse({
      type: "discord",
      name: "Discord",
      botToken: "token",
      applicationId: "app-id",
      discordSupervisor: {
        enabled: true,
        coordinationChannelId: "123",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a fully configured supervisor mode payload", () => {
    const result = AddDiscordChannelSchema.safeParse({
      type: "discord",
      name: "Discord",
      botToken: "token",
      applicationId: "app-id",
      discordSupervisor: {
        enabled: true,
        coordinationChannelId: "123",
        peerBotUserIds: ["456"],
        workerAgentRoleId: "550e8400-e29b-41d4-a716-446655440000",
        supervisorAgentRoleId: "550e8400-e29b-41d4-a716-446655440001",
      },
    });

    expect(result.success).toBe(true);
  });
});
