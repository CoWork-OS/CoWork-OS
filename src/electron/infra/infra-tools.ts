/**
 * InfraTools - Agent tools for cloud infrastructure operations
 *
 * Provides native tools for: cloud sandboxes (E2B), domains (Namecheap),
 * wallet management, and x402 payments. Registered directly in ToolRegistry.
 */

import { Workspace } from "../../shared/types";
import { AgentDaemon } from "../agent/daemon";
import { LLMTool } from "../agent/llm/types";
import { InfraManager } from "./infra-manager";

export class InfraTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      // === Cloud Sandbox Tools ===
      {
        name: "cloud_sandbox_create",
        description:
          "Create a new cloud sandbox (Linux VM). Returns sandbox ID and connection info. " +
          "Use this to spin up an isolated environment for running code, deploying services, etc.",
        input_schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Friendly name for the sandbox",
            },
            timeout_minutes: {
              type: "number",
              description:
                "How long the sandbox should stay alive (default: 5 minutes, max: 60 for free tier)",
            },
            envs: {
              type: "object",
              description: "Environment variables to set in the sandbox",
              additionalProperties: { type: "string" },
            },
          },
          required: [],
        },
      },
      {
        name: "cloud_sandbox_exec",
        description:
          "Execute a shell command in a cloud sandbox. Returns stdout, stderr, and exit code.",
        input_schema: {
          type: "object",
          properties: {
            sandbox_id: {
              type: "string",
              description: "The sandbox ID",
            },
            command: {
              type: "string",
              description: "Shell command to run",
            },
            background: {
              type: "boolean",
              description: "Run in background (don't wait for completion)",
            },
          },
          required: ["sandbox_id", "command"],
        },
      },
      {
        name: "cloud_sandbox_write_file",
        description: "Write a file to a cloud sandbox.",
        input_schema: {
          type: "object",
          properties: {
            sandbox_id: { type: "string", description: "The sandbox ID" },
            path: { type: "string", description: "File path inside the sandbox" },
            content: { type: "string", description: "File content to write" },
          },
          required: ["sandbox_id", "path", "content"],
        },
      },
      {
        name: "cloud_sandbox_read_file",
        description: "Read a file from a cloud sandbox.",
        input_schema: {
          type: "object",
          properties: {
            sandbox_id: { type: "string", description: "The sandbox ID" },
            path: { type: "string", description: "File path inside the sandbox" },
          },
          required: ["sandbox_id", "path"],
        },
      },
      {
        name: "cloud_sandbox_list",
        description: "List all active cloud sandboxes.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "cloud_sandbox_delete",
        description: "Delete a cloud sandbox and free resources.",
        input_schema: {
          type: "object",
          properties: {
            sandbox_id: { type: "string", description: "The sandbox ID to delete" },
          },
          required: ["sandbox_id"],
        },
      },
      {
        name: "cloud_sandbox_url",
        description: "Get the public URL for an exposed port on a cloud sandbox.",
        input_schema: {
          type: "object",
          properties: {
            sandbox_id: { type: "string", description: "The sandbox ID" },
            port: { type: "number", description: "Port number to expose" },
          },
          required: ["sandbox_id", "port"],
        },
      },

      // === Domain Tools ===
      {
        name: "domain_search",
        description:
          "Search for available domains. Returns availability and pricing for requested TLDs.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Domain name to search (without TLD)" },
            tlds: {
              type: "array",
              items: { type: "string" },
              description: "TLDs to check (default: com, net, org, io, ai, dev, app)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "domain_register",
        description: "Register a domain name. Requires user approval before proceeding.",
        input_schema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Full domain name to register (e.g. example.com)",
            },
            years: { type: "number", description: "Registration years (default: 1)" },
          },
          required: ["domain"],
        },
      },
      {
        name: "domain_list",
        description: "List all domains registered on the configured account.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "domain_dns_list",
        description: "List DNS records for a domain.",
        input_schema: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Domain name" },
          },
          required: ["domain"],
        },
      },
      {
        name: "domain_dns_add",
        description: "Add a DNS record to a domain.",
        input_schema: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Domain name" },
            type: {
              type: "string",
              enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS"],
              description: "Record type",
            },
            name: { type: "string", description: "Record name (e.g. '@' for root, 'www')" },
            value: { type: "string", description: "Record value (IP address, hostname, etc.)" },
            ttl: { type: "number", description: "TTL in seconds (default: 1800)" },
            priority: { type: "number", description: "Priority (for MX records)" },
          },
          required: ["domain", "type", "name", "value"],
        },
      },
      {
        name: "domain_dns_delete",
        description: "Delete a DNS record from a domain.",
        input_schema: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Domain name" },
            type: { type: "string", description: "Record type to delete" },
            name: { type: "string", description: "Record name to delete" },
          },
          required: ["domain", "type", "name"],
        },
      },

      // === Wallet & Payment Tools ===
      {
        name: "wallet_info",
        description:
          "Get wallet address, network, and USDC balance. The wallet is used for infrastructure payments.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "wallet_balance",
        description: "Get the current USDC balance of the infrastructure wallet.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "x402_check",
        description:
          "Check if a URL requires x402 payment. Returns payment details if 402 status is returned.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to check" },
          },
          required: ["url"],
        },
      },
      {
        name: "x402_fetch",
        description:
          "Fetch a URL with automatic x402 payment. If the server returns 402, signs a payment and retries. " +
          "Requires user approval before any payment is executed.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            method: { type: "string", description: "HTTP method (default: GET)" },
            body: { type: "string", description: "Request body (for POST/PUT)" },
          },
          required: ["url"],
        },
      },

      // === Infrastructure Status Tools ===
      {
        name: "infra_status",
        description:
          "Get overall infrastructure status: provider connections, active sandboxes, wallet state.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ];
  }

  /**
   * Execute a tool by name
   */
  async executeTool(toolName: string, args: Record<string, Any>): Promise<Any> {
    const manager = InfraManager.getInstance();

    this.daemon.logEvent(this.taskId, "tool_call", { tool: toolName, args });

    try {
      let result: Any;

      switch (toolName) {
        // Sandbox tools
        case "cloud_sandbox_create":
          result = await manager.sandboxCreate({
            name: args.name,
            timeoutMs: args.timeout_minutes ? args.timeout_minutes * 60_000 : undefined,
            envs: args.envs,
          });
          break;

        case "cloud_sandbox_exec":
          result = await manager.sandboxExec(args.sandbox_id, args.command, {
            background: args.background,
          });
          break;

        case "cloud_sandbox_write_file":
          await manager.sandboxWriteFile(args.sandbox_id, args.path, args.content);
          result = { success: true, path: args.path };
          break;

        case "cloud_sandbox_read_file":
          result = { content: await manager.sandboxReadFile(args.sandbox_id, args.path) };
          break;

        case "cloud_sandbox_list":
          result = { sandboxes: manager.sandboxList() };
          break;

        case "cloud_sandbox_delete":
          await manager.sandboxDelete(args.sandbox_id);
          result = { success: true, sandbox_id: args.sandbox_id };
          break;

        case "cloud_sandbox_url":
          result = { url: manager.sandboxGetUrl(args.sandbox_id, args.port) };
          break;

        // Domain tools
        case "domain_search":
          result = await manager.domainSearch(args.query, args.tlds);
          break;

        case "domain_register": {
          // Require user approval for domain registration
          const approved = await this.daemon.requestApproval(
            this.taskId,
            "external_service",
            `Register domain "${args.domain}" for ${args.years || 1} year(s)?`,
            { tool: "domain_register", params: args },
          );
          if (!approved) {
            result = { error: "Domain registration was not approved by the user." };
            break;
          }
          result = await manager.domainRegister(args.domain, args.years);
          break;
        }

        case "domain_list":
          result = await manager.domainList();
          break;

        case "domain_dns_list":
          result = await manager.domainDnsList(args.domain);
          break;

        case "domain_dns_add":
          result = await manager.domainDnsAdd(args.domain, {
            type: args.type,
            name: args.name,
            value: args.value,
            ttl: args.ttl || 1800,
            priority: args.priority,
          });
          break;

        case "domain_dns_delete":
          result = await manager.domainDnsDelete(args.domain, args.type, args.name);
          break;

        // Wallet tools
        case "wallet_info":
          result = await manager.getWalletInfoWithBalance();
          break;

        case "wallet_balance":
          result = { balance: await manager.getWalletBalance(), currency: "USDC", network: "Base" };
          break;

        // x402 tools
        case "x402_check":
          result = await manager.x402Check(args.url);
          break;

        case "x402_fetch": {
          // Require user approval for x402 payments
          const payApproved = await this.daemon.requestApproval(
            this.taskId,
            "external_service",
            `Make an x402 payment request to "${args.url}"? This may deduct USDC from your wallet.`,
            { tool: "x402_fetch", params: args, reason: "x402 payment operation" },
          );
          if (!payApproved) {
            result = { error: "x402 payment was not approved by the user." };
            break;
          }
          result = await manager.x402Fetch(args.url, {
            method: args.method,
            body: args.body,
          });
          break;
        }

        // Status
        case "infra_status":
          result = manager.getStatus();
          break;

        default:
          result = { error: `Unknown infrastructure tool: ${toolName}` };
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: toolName,
        success: !result?.error,
      });

      return result;
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: toolName,
        success: false,
        error: error.message,
      });
      return { error: error.message || String(error) };
    }
  }
}
