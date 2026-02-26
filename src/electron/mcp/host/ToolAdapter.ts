/**
 * ToolAdapter - Adapts CoWork's ToolRegistry to the MCP protocol
 *
 * Converts tool definitions from LLMTool format to MCPTool format
 * and handles tool execution through the ToolRegistry.
 */

import { MCPTool } from "../types";
import { ToolProvider } from "./MCPHostServer";

// Interface matching LLMTool from ToolRegistry
interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, Any>;
    required?: string[];
  };
}

// ToolRegistry interface
export interface ToolRegistry {
  getTools(): LLMTool[];
  executeTool(name: string, input: Record<string, Any>): Promise<Any>;
}

/**
 * Adapts a ToolRegistry to the ToolProvider interface expected by MCPHostServer
 */
export class ToolAdapter implements ToolProvider {
  private registry: ToolRegistry;
  private exposedTools: Set<string>;
  private excludedTools: Set<string>;

  constructor(
    registry: ToolRegistry,
    options: {
      // Only expose these tools (if specified)
      exposedTools?: string[];
      // Exclude these tools from exposure
      excludedTools?: string[];
    } = {},
  ) {
    this.registry = registry;
    this.exposedTools = options.exposedTools ? new Set(options.exposedTools) : new Set();
    this.excludedTools = new Set(
      options.excludedTools || [
        // Default exclusions - dangerous or internal tools
        "computer_tool", // Computer control
        "bash", // Direct shell access
        "text_editor", // Direct file editing
      ],
    );
  }

  /**
   * Get tools in MCP format
   */
  getTools(): MCPTool[] {
    const llmTools = this.registry.getTools();

    // Filter and convert tools
    return llmTools
      .filter((tool) => this.shouldExposePlugin(tool.name))
      .map((tool) => this.convertTool(tool));
  }

  /**
   * Execute a tool and return MCP-formatted result
   */
  async executeTool(name: string, args: Record<string, Any>): Promise<Any> {
    // Verify tool is exposed
    if (!this.shouldExposePlugin(name)) {
      throw new Error(`Tool ${name} is not available`);
    }

    // Execute through registry
    const result = await this.registry.executeTool(name, args);
    return result;
  }

  /**
   * Check if a tool should be exposed via MCP
   */
  private shouldExposePlugin(name: string): boolean {
    // If exposedTools is set, only expose those
    if (this.exposedTools.size > 0) {
      return this.exposedTools.has(name);
    }

    // Otherwise, expose all except excluded
    return !this.excludedTools.has(name);
  }

  /**
   * Convert an LLMTool to MCPTool format
   */
  private convertTool(tool: LLMTool): MCPTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: tool.input_schema.properties,
        required: tool.input_schema.required,
      },
    };
  }

  /**
   * Add a tool to the exposed list
   */
  exposeTool(name: string): void {
    this.exposedTools.add(name);
    this.excludedTools.delete(name);
  }

  /**
   * Remove a tool from exposure
   */
  hideTool(name: string): void {
    this.exposedTools.delete(name);
    this.excludedTools.add(name);
  }

  /**
   * Get list of available tool names
   */
  getAvailableToolNames(): string[] {
    return this.registry
      .getTools()
      .filter((tool) => this.shouldExposePlugin(tool.name))
      .map((tool) => tool.name);
  }

  /**
   * Get list of all tool names (including hidden)
   */
  getAllToolNames(): string[] {
    return this.registry.getTools().map((tool) => tool.name);
  }
}
