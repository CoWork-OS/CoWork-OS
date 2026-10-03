import type { MCPServerConfig } from "./types";

/** Driver identity comes from local configuration, never server descriptions. */
export function isCodexComputerUseServer(server: MCPServerConfig | undefined | null): boolean {
  return Boolean(
    server?.transport === "stdio" &&
    server.args?.some((arg) => arg.endsWith("/@oai/cua-repl/bin/cua-repl.mjs")) &&
    server.env?.CUA_REPL_ENABLED_SURFACES?.split(",").includes("computer"),
  );
}

/** Only app-specific consent can be reused. Audio and general forms stay per operation. */
export function codexComputerUseAppConsent(
  meta: unknown,
  message: string,
): { id: string; name: string } | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
  const value = meta as Record<string, Any>;
  if (value.connector_id !== "computer-use" || value.codex_approval_kind !== "mcp_tool_call")
    return;
  const id = value.tool_params?.app;
  const display = Array.isArray(value.tool_params_display)
    ? value.tool_params_display.find((item: Any) => item?.name === "app")
    : undefined;
  const name = display?.value;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(id)) return;
  if (typeof name !== "string" || !name.trim() || name.length > 200) return;
  if (message !== `Allow Computer Use to use "${name}"?`) return;
  return { id, name };
}
