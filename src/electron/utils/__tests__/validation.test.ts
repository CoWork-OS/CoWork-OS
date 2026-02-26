import { describe, expect, it } from "vitest";
import {
  validateInput,
  WorkspaceCreateSchema,
  TaskCreateSchema,
  ApprovalResponseSchema,
  GuardrailSettingsSchema,
  ChannelConfigSchema,
  EmailChannelConfigSchema,
  AddEmailChannelSchema,
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
});
