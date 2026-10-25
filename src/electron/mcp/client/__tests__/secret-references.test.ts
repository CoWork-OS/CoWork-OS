import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetResolvedSecretsForTests,
  rememberResolvedSecret,
} from "../../../security/secret-references/known-secret-values";
import { withoutVaultTokens } from "../../../security/secret-references/secret-cli";
import type { MCPServerConfig } from "../../types";
import { redactMcpCallResult, resolveMcpServerSecrets } from "../secret-references";

afterEach(() => _resetResolvedSecretsForTests());

const base: MCPServerConfig = {
  id: "github",
  name: "GitHub",
  enabled: true,
  transport: "stdio",
  command: "github-mcp",
} as MCPServerConfig;

describe("MCP vault references", () => {
  it("leaves a config without references untouched", async () => {
    const resolver = { resolveRecord: vi.fn() };
    const config = { ...base, env: { LOG_LEVEL: "info" } };
    await expect(resolveMcpServerSecrets(config, resolver)).resolves.toBe(config);
    expect(resolver.resolveRecord).not.toHaveBeenCalled();
  });

  it("resolves env and header references for the connection only", async () => {
    const resolver = {
      resolveRecord: vi.fn(async (record?: Record<string, string>) =>
        record
          ? Object.fromEntries(
              Object.entries(record).map(([k, v]) => [k, v.startsWith("op://") ? "ghp_secret" : v]),
            )
          : record,
      ),
    };
    const config = {
      ...base,
      env: { GITHUB_TOKEN: "op://Dev/GitHub/token", LOG_LEVEL: "info" },
      headers: { Authorization: "op://Dev/GitHub/header" },
    };
    const resolved = await resolveMcpServerSecrets(config, resolver);
    expect(resolved.env).toEqual({ GITHUB_TOKEN: "ghp_secret", LOG_LEVEL: "info" });
    expect(resolved.headers).toEqual({ Authorization: "ghp_secret" });
    expect(config.env.GITHUB_TOKEN).toBe("op://Dev/GitHub/token");
  });

  it("masks a resolved value a server echoes back", () => {
    rememberResolvedSecret("ghp_secret_value_123");
    const result = redactMcpCallResult({
      content: [
        { type: "text", text: "token=ghp_secret_value_123" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      structuredContent: { env: { GITHUB_TOKEN: "ghp_secret_value_123" } },
    } as never);
    expect(result.content[0]).toEqual({ type: "text", text: "token=[REDACTED_VAULT_SECRET]" });
    expect(result.content[1]).toMatchObject({ type: "image" });
    expect(result.structuredContent).toEqual({ env: { GITHUB_TOKEN: "[REDACTED_VAULT_SECRET]" } });
  });

  it("returns the same result object when nothing needs masking", () => {
    const result = { content: [{ type: "text", text: "plain" }] } as never;
    expect(redactMcpCallResult(result)).toBe(result);
  });

  it("keeps vault tokens out of the environment MCP servers inherit", () => {
    expect(
      withoutVaultTokens({
        PATH: "/usr/bin",
        OP_SERVICE_ACCOUNT_TOKEN: "ops_x",
        OP_SESSION_team: "s",
        BWS_ACCESS_TOKEN: "0.x",
        BW_SESSION: "bw",
        OPENAI_API_KEY: "kept-as-before",
      }),
    ).toEqual({ PATH: "/usr/bin", OPENAI_API_KEY: "kept-as-before" });
  });
});
