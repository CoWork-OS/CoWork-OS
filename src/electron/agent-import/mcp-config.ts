/**
 * MCP servers from a Claude Code (`~/.claude.json`) or Cursor (`~/.cursor/mcp.json`)
 * `mcpServers` map. Both use the same shape: `command`/`args`/`env` for a local server,
 * `url`/`headers` for a remote one, and an optional `type`.
 *
 * Header values, credential-looking env values and token-looking arguments or address
 * parts are secrets: a server that has them is listed but left out unless secrets are
 * opted in, and its preview line never shows them. Values that still hold a `${VAR}`
 * placeholder are left out too, because CoWork does not fill them in.
 */

import * as path from "node:path";
import {
  readyItem,
  SECRETS_OPT_IN_REASON,
  skippedItem,
  type ImportMcpServer,
  type PlannedImportItem,
} from "./plan";
import { isSecretEnvKey, looksLikeSecret, shortDescription } from "./source-files";

export { looksLikeSecret } from "./source-files";

const MAX_SERVERS = 200;
const PLACEHOLDER = /\$\{[^}]*\}/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    }
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" || typeof entry === "number").map(String)
    : [];
}

/** A flag whose value is a credential (`--api-key X`, `--token=X`). */
function isSecretFlag(arg: string): boolean {
  return /^--?[\w-]*(key|token|secret|password|auth)[\w-]*(=|$)/i.test(arg);
}

/** True when the http(s) URL is well formed. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Only the origin: paths and queries can carry a key (`/mcp/<key>/sse`). */
function displayUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * The program and at most two plain arguments (a package name, a script): flags and
 * whatever follows them are never shown, since a short password can be positional
 * (`mysql -pHunter2`).
 */
function displayCommand(command: string, args: readonly string[]): string {
  const shown = [path.basename(command)];
  for (const arg of args) {
    if (shown.length > 2) break;
    if (arg.startsWith("-") || arg.includes("=") || looksLikeSecret(arg) || arg.length > 80) {
      continue;
    }
    shown.push(arg);
  }
  return shown.join(" ");
}

/** Words in an env name that mark its value as a credential (`GITHUB_PAT`, `AUTH`). */
const SECRET_KEY_PARTS = new Set([
  "KEY",
  "APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PAT",
  "AUTH",
  "BEARER",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "SESSION",
]);

/** An env entry that holds a credential, by its name or by the look of its value. */
function isSecretEnvEntry(key: string, value: string): boolean {
  const parts = key.toUpperCase().split(/[^A-Z0-9]+/);
  return (
    isSecretEnvKey(key) ||
    parts.some((part) => SECRET_KEY_PARTS.has(part)) ||
    looksLikeSecret(value) ||
    /:\/\/[^/\s@]*:[^/\s@]+@/.test(value)
  );
}

export function readMcpServers(
  mcpServers: unknown,
  options: { withSecrets: boolean; sourceLabel: string },
): PlannedImportItem[] {
  const items: PlannedImportItem[] = [];
  const entries = Object.entries(asRecord(mcpServers)).slice(0, MAX_SERVERS);
  for (const [rawName, rawConfig] of entries) {
    const name = rawName.trim();
    if (!name) continue;
    const config = asRecord(rawConfig);
    const id = `mcp:${name.toLowerCase()}`;
    const label = `MCP server: ${name}`;
    const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
    const command = typeof config.command === "string" ? config.command.trim() : "";
    const url = typeof config.url === "string" ? config.url.trim() : "";

    if (config.disabled === true) {
      items.push(skippedItem(id, "mcp_server", label, `Turned off in ${options.sourceLabel}.`));
      continue;
    }

    let server: ImportMcpServer;
    let secretValues: string[] = [];
    if (command) {
      const env = stringMap(config.env);
      const args = stringList(config.args);
      const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : "";
      secretValues = [
        ...Object.entries(env)
          .filter(([key, value]) => isSecretEnvEntry(key, value))
          .map(([, value]) => value),
        ...args.filter(
          (arg, index) =>
            looksLikeSecret(arg) ||
            (index > 0 && isSecretFlag(args[index - 1]) && !args[index - 1].includes("=")) ||
            (isSecretFlag(arg) && arg.includes("=")),
        ),
      ];
      server = {
        name,
        transport: "stdio",
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      };
    } else if (url) {
      if (!isHttpUrl(url)) {
        items.push(skippedItem(id, "mcp_server", label, "Not an http or https address."));
        continue;
      }
      const headers = stringMap(config.headers);
      let urlParts: string[] = [];
      try {
        const parsed = new URL(url);
        urlParts = [...parsed.pathname.split("/"), ...parsed.searchParams.values()];
        if (parsed.password) urlParts.push(parsed.password);
      } catch {
        urlParts = [];
      }
      secretValues = [...Object.values(headers), ...urlParts.filter(looksLikeSecret)];
      server = {
        name,
        transport: type === "sse" ? "sse" : "streamable-http",
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
    } else {
      items.push(
        skippedItem(
          id,
          "mcp_server",
          label,
          type ? `A ${type} server CoWork can't run.` : "No command or address.",
        ),
      );
      continue;
    }

    const all = [
      server.command ?? "",
      ...(server.args ?? []),
      server.cwd ?? "",
      server.url ?? "",
      ...Object.values(server.env ?? {}),
      ...Object.values(server.headers ?? {}),
    ];
    if (all.some((value) => PLACEHOLDER.test(value))) {
      items.push(
        skippedItem(
          id,
          "mcp_server",
          label,
          "Uses ${VAR} placeholders CoWork doesn't fill in; add it in Settings > MCP Servers.",
        ),
      );
      continue;
    }

    const detail = shortDescription(
      server.transport === "stdio"
        ? displayCommand(server.command ?? "", server.args ?? [])
        : displayUrl(server.url ?? ""),
    );
    if (secretValues.length > 0 && !options.withSecrets) {
      items.push(
        skippedItem(id, "mcp_server", label, SECRETS_OPT_IN_REASON, { detail, secret: true }),
      );
      continue;
    }
    items.push(
      readyItem(
        id,
        "mcp_server",
        label,
        { kind: "mcp_server", server },
        { detail, secret: secretValues.length > 0 },
      ),
    );
  }
  return items;
}
