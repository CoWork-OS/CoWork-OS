/**
 * E2B Cloud Sandbox Provider
 *
 * Provides cloud sandbox (Linux VM) management using the E2B SDK.
 * Each sandbox is a full Linux environment that can run code, expose ports, etc.
 */

import { Sandbox } from "e2b";
import { InfraSandboxInfo } from "../../../shared/types";

interface SandboxEntry {
  sandbox: Sandbox;
  info: InfraSandboxInfo;
}

export class E2BSandboxProvider {
  private sandboxes = new Map<string, SandboxEntry>();
  private apiKey: string = "";

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Create a new cloud sandbox
   */
  async create(opts?: {
    name?: string;
    timeoutMs?: number;
    envs?: Record<string, string>;
  }): Promise<InfraSandboxInfo> {
    if (!this.apiKey) throw new Error("E2B API key not configured");

    const sandbox = await Sandbox.create({
      apiKey: this.apiKey,
      timeoutMs: opts?.timeoutMs || 300_000, // 5 min default
      envs: opts?.envs,
    });

    const info: InfraSandboxInfo = {
      id: sandbox.sandboxId,
      name: opts?.name || `sandbox-${Date.now()}`,
      status: "running",
      createdAt: Date.now(),
    };

    this.sandboxes.set(sandbox.sandboxId, { sandbox, info });

    console.log(`[E2B] Created sandbox: ${sandbox.sandboxId}`);
    return info;
  }

  /**
   * Run a command in a sandbox
   */
  async exec(
    sandboxId: string,
    command: string,
    opts?: { timeoutMs?: number; background?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const entry = await this.getOrReconnect(sandboxId);

    if (opts?.background) {
      const handle = await entry.sandbox.commands.run(command, { background: true });
      return { stdout: `Background process started (PID: ${handle.pid})`, stderr: "", exitCode: 0 };
    }

    const result = await entry.sandbox.commands.run(command, {
      timeoutMs: opts?.timeoutMs || 60_000,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * Write a file to a sandbox
   */
  async writeFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    const entry = await this.getOrReconnect(sandboxId);
    await entry.sandbox.files.write(filePath, content);
  }

  /**
   * Read a file from a sandbox
   */
  async readFile(sandboxId: string, filePath: string): Promise<string> {
    const entry = await this.getOrReconnect(sandboxId);
    return await entry.sandbox.files.read(filePath, { format: "text" });
  }

  /**
   * List files in a directory
   */
  async listFiles(sandboxId: string, dirPath: string): Promise<string[]> {
    const entry = await this.getOrReconnect(sandboxId);
    const entries = await entry.sandbox.files.list(dirPath);
    return entries.map((e) => e.name);
  }

  /**
   * Get the public URL for an exposed port
   */
  getUrl(sandboxId: string, port: number): string {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`Sandbox ${sandboxId} not found`);
    return `https://${entry.sandbox.getHost(port)}`;
  }

  /**
   * List all active sandboxes
   */
  list(): InfraSandboxInfo[] {
    return Array.from(this.sandboxes.values()).map((e) => e.info);
  }

  /**
   * Kill and remove a sandbox
   */
  async delete(sandboxId: string): Promise<void> {
    const entry = this.sandboxes.get(sandboxId);
    if (entry) {
      try {
        await entry.sandbox.kill();
      } catch (error) {
        console.warn(`[E2B] Failed to kill sandbox ${sandboxId}:`, error);
      }
      this.sandboxes.delete(sandboxId);
    }
    console.log(`[E2B] Deleted sandbox: ${sandboxId}`);
  }

  /**
   * Check if a sandbox is still running
   */
  async isRunning(sandboxId: string): Promise<boolean> {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) return false;
    try {
      return await entry.sandbox.isRunning();
    } catch {
      return false;
    }
  }

  /**
   * Clean up all sandboxes
   */
  async cleanup(): Promise<void> {
    const ids = Array.from(this.sandboxes.keys());
    for (const id of ids) {
      await this.delete(id);
    }
  }

  /**
   * Get or reconnect to a sandbox
   */
  private async getOrReconnect(sandboxId: string): Promise<SandboxEntry> {
    let entry = this.sandboxes.get(sandboxId);
    if (entry) return entry;

    // Try to reconnect
    if (!this.apiKey) throw new Error("E2B API key not configured");

    try {
      const sandbox = await Sandbox.connect(sandboxId, { apiKey: this.apiKey });
      const info: InfraSandboxInfo = {
        id: sandboxId,
        status: "running",
        createdAt: Date.now(),
      };
      entry = { sandbox, info };
      this.sandboxes.set(sandboxId, entry);
      return entry;
    } catch (error) {
      throw new Error(`Sandbox ${sandboxId} not found or unable to reconnect: ${error}`);
    }
  }
}
