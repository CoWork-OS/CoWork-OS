/**
 * Declarative Connector Loader
 *
 * Converts JSON-based DeclarativeConnector definitions into executable
 * RegisterToolOptions objects. Enables community tool contributions
 * without requiring TypeScript.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as vm from "vm";
import { DeclarativeConnector, RegisterToolOptions } from "./types";

const execAsync = promisify(exec);

const MAX_SHELL_TIMEOUT = 60_000;
const DEFAULT_SHELL_TIMEOUT = 30_000;
const MAX_SCRIPT_TIMEOUT = 10_000;
const DEFAULT_SCRIPT_TIMEOUT = 5_000;

/**
 * Expand {{param}} placeholders in a template string with input values.
 */
function expandTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = input[key];
    return val !== undefined && val !== null ? String(val) : "";
  });
}

/**
 * Shell-escape a value to prevent command injection.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Expand {{param}} placeholders with shell-escaped values for safe use in
 * shell commands.  Each interpolated value is wrapped in single quotes.
 */
function expandShellTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = input[key];
    if (val === undefined || val === null) return "''";
    return shellEscape(String(val));
  });
}

/**
 * Validate that a URL string is well-formed and uses an allowed protocol.
 */
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate a DeclarativeConnector definition.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateConnector(connector: DeclarativeConnector): string | null {
  if (!connector.name || typeof connector.name !== "string") {
    return "Connector missing required field: name";
  }
  if (!connector.description || typeof connector.description !== "string") {
    return "Connector missing required field: description";
  }
  if (!connector.type || !["http", "shell", "script"].includes(connector.type)) {
    return `Connector has invalid type: ${connector.type}. Must be: http, shell, or script`;
  }
  if (!connector.inputSchema || typeof connector.inputSchema !== "object") {
    return "Connector missing required field: inputSchema";
  }
  if (connector.type === "http" && !connector.http) {
    return "HTTP connector missing required field: http";
  }
  if (connector.type === "http" && connector.http) {
    if (!connector.http.url) return "HTTP connector missing required field: http.url";
    if (!connector.http.method) return "HTTP connector missing required field: http.method";
  }
  if (connector.type === "shell" && !connector.shell) {
    return "Shell connector missing required field: shell";
  }
  if (connector.type === "shell" && connector.shell) {
    if (!connector.shell.command) return "Shell connector missing required field: shell.command";
  }
  if (connector.type === "script" && !connector.script) {
    return "Script connector missing required field: script";
  }
  if (connector.type === "script" && connector.script) {
    if (!connector.script.body) return "Script connector missing required field: script.body";
  }
  return null;
}

/**
 * Convert a DeclarativeConnector into a RegisterToolOptions with an executable handler.
 */
export function createToolFromConnector(
  connector: DeclarativeConnector,
  pluginName: string,
): RegisterToolOptions {
  const error = validateConnector(connector);
  if (error) {
    console.error(`[DeclarativeConnector] Invalid connector ${connector.name}: ${error}`);
    return {
      name: connector.name,
      description: connector.description || "Invalid connector",
      inputSchema: connector.inputSchema || { type: "object", properties: {} },
      handler: async () => ({
        error: `Connector ${connector.name} is invalid: ${error}`,
      }),
    };
  }

  return {
    name: connector.name,
    description: connector.description,
    inputSchema: connector.inputSchema,
    handler: createConnectorHandler(connector, pluginName),
  };
}

function createConnectorHandler(
  connector: DeclarativeConnector,
  _pluginName: string,
): (input: Record<string, unknown>) => Promise<unknown> {
  switch (connector.type) {
    case "http":
      return createHttpHandler(connector);
    case "shell":
      return createShellHandler(connector);
    case "script":
      return createScriptHandler(connector);
    default:
      return async () => ({ error: `Unknown connector type: ${connector.type}` });
  }
}

function createHttpHandler(
  connector: DeclarativeConnector,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input: Record<string, unknown>): Promise<unknown> => {
    const config = connector.http!;
    const url = expandTemplate(config.url, input);

    if (!isAllowedUrl(url)) {
      return { error: `Invalid or disallowed URL: ${url}` };
    }

    const headers: Record<string, string> = {};
    if (config.headers) {
      for (const [key, val] of Object.entries(config.headers)) {
        headers[key] = expandTemplate(val, input);
      }
    }

    const fetchOptions: globalThis.RequestInit = {
      method: config.method,
      headers,
    };

    if (config.body && config.method !== "GET") {
      fetchOptions.body = expandTemplate(config.body, input);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    try {
      const response = await fetch(url, fetchOptions);
      if (config.responseFormat === "text") {
        return { status: response.status, body: await response.text() };
      }
      return { status: response.status, body: await response.json() };
    } catch (err) {
      return {
        error: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

function createShellHandler(
  connector: DeclarativeConnector,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input: Record<string, unknown>): Promise<unknown> => {
    const config = connector.shell!;
    // Use shell-escaped interpolation to prevent command injection
    const command = expandShellTemplate(config.command, input);
    const timeout = Math.min(config.timeout || DEFAULT_SHELL_TIMEOUT, MAX_SHELL_TIMEOUT);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: config.cwd,
        timeout,
      });
      return { stdout, stderr };
    } catch (err) {
      return {
        error: `Shell command failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

function createScriptHandler(
  connector: DeclarativeConnector,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input: Record<string, unknown>): Promise<unknown> => {
    const config = connector.script!;
    const timeout = Math.min(config.timeout || DEFAULT_SCRIPT_TIMEOUT, MAX_SCRIPT_TIMEOUT);

    try {
      // Run in an isolated VM context to limit access to Node globals.
      // Note: vm contexts are not a full security sandbox but prevent
      // accidental access to require/process/global from plugin scripts.
      const sandbox = { input, result: undefined as unknown };
      const ctx = vm.createContext(sandbox);
      const script = new vm.Script(`result = (function(input) { ${config.body} })(input);`);
      script.runInContext(ctx, { timeout });
      return sandbox.result;
    } catch (err) {
      return {
        error: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
