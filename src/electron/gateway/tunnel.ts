/**
 * Webhook Tunnel Manager
 *
 * Provides automatic tunnel creation for webhook-based channel adapters.
 * Supports multiple tunnel providers:
 * - ngrok: Popular tunneling service (requires account for persistent URLs)
 * - Tailscale Funnel: Private networking with public endpoints
 * - Cloudflare Tunnel: Enterprise-grade tunneling (cloudflared)
 *
 * Usage:
 *   const tunnel = new TunnelManager({ provider: 'ngrok', port: 3000 });
 *   const url = await tunnel.start();
 *   // Use url for webhook configuration
 *   await tunnel.stop();
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { EventEmitter } from "events";
import * as _net from "net";
import * as http from "http";
import * as https from "https";

/**
 * Tunnel provider types
 */
export type TunnelProvider = "ngrok" | "tailscale" | "cloudflare" | "localtunnel";

/**
 * Tunnel status
 */
export type TunnelStatus = "stopped" | "starting" | "running" | "error";

/**
 * Tunnel configuration
 */
export interface TunnelConfig {
  /** Tunnel provider to use */
  provider: TunnelProvider;

  /** Local port to tunnel */
  port: number;

  /** Local host (default: localhost) */
  host?: string;

  /** ngrok auth token (optional, enables more features) */
  ngrokAuthToken?: string;

  /** ngrok region (default: us) */
  ngrokRegion?: "us" | "eu" | "ap" | "au" | "sa" | "jp" | "in";

  /** ngrok subdomain (requires paid plan) */
  ngrokSubdomain?: string;

  /** Tailscale funnel hostname */
  tailscaleHostname?: string;

  /** Cloudflare tunnel name */
  cloudflareTunnelName?: string;

  /** Cloudflare credentials file */
  cloudflareCredentialsFile?: string;

  /** Protocol (default: https for ngrok/tailscale, http for localtunnel) */
  protocol?: "http" | "https";

  /** Path prefix for webhook endpoint */
  pathPrefix?: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Auto-restart on failure */
  autoRestart?: boolean;

  /** Restart delay in ms (default: 5000) */
  restartDelay?: number;
}

/**
 * Tunnel information
 */
export interface TunnelInfo {
  /** Public URL */
  url: string;

  /** Tunnel provider */
  provider: TunnelProvider;

  /** Local port */
  port: number;

  /** Tunnel status */
  status: TunnelStatus;

  /** Started at timestamp */
  startedAt?: Date;

  /** Error message (if status is error) */
  error?: string;

  /** Additional provider-specific info */
  extra?: Record<string, unknown>;
}

/**
 * Tunnel Manager
 */
export class TunnelManager extends EventEmitter {
  private config: Required<TunnelConfig>;
  private process?: ChildProcess;
  private _status: TunnelStatus = "stopped";
  private _url?: string;
  private _startedAt?: Date;
  private _error?: string;
  private restartTimer?: NodeJS.Timeout;

  constructor(config: TunnelConfig) {
    super();

    this.config = {
      host: "localhost",
      protocol: config.provider === "localtunnel" ? "http" : "https",
      pathPrefix: "",
      verbose: false,
      autoRestart: true,
      restartDelay: 5000,
      ngrokRegion: "us",
      ...config,
    } as Required<TunnelConfig>;
  }

  /**
   * Get current status
   */
  get status(): TunnelStatus {
    return this._status;
  }

  /**
   * Get tunnel URL
   */
  get url(): string | undefined {
    return this._url;
  }

  /**
   * Get tunnel info
   */
  getInfo(): TunnelInfo {
    return {
      url: this._url || "",
      provider: this.config.provider,
      port: this.config.port,
      status: this._status,
      startedAt: this._startedAt,
      error: this._error,
    };
  }

  /**
   * Start the tunnel
   */
  async start(): Promise<string> {
    if (this._status === "running") {
      return this._url!;
    }

    if (this._status === "starting") {
      // Wait for startup to complete
      return new Promise((resolve, reject) => {
        const onRunning = () => {
          this.off("error", onError);
          resolve(this._url!);
        };
        const onError = (error: Error) => {
          this.off("running", onRunning);
          reject(error);
        };
        this.once("running", onRunning);
        this.once("error", onError);
      });
    }

    this._status = "starting";
    this._error = undefined;
    this.emit("starting");

    try {
      // Check if provider is available
      await this.checkProviderInstalled();

      // Start the tunnel
      switch (this.config.provider) {
        case "ngrok":
          this._url = await this.startNgrok();
          break;
        case "tailscale":
          this._url = await this.startTailscale();
          break;
        case "cloudflare":
          this._url = await this.startCloudflare();
          break;
        case "localtunnel":
          this._url = await this.startLocaltunnel();
          break;
        default:
          throw new Error(`Unsupported tunnel provider: ${this.config.provider}`);
      }

      this._status = "running";
      this._startedAt = new Date();
      this.emit("running", this._url);

      if (this.config.verbose) {
        console.log(`Tunnel started: ${this._url}`);
      }

      return this._url;
    } catch (error) {
      this._status = "error";
      this._error = error instanceof Error ? error.message : String(error);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Stop the tunnel
   */
  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = undefined;
    }

    this._status = "stopped";
    this._url = undefined;
    this._startedAt = undefined;
    this.emit("stopped");

    if (this.config.verbose) {
      console.log("Tunnel stopped");
    }
  }

  /**
   * Restart the tunnel
   */
  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  /**
   * Check if the provider is installed
   */
  private async checkProviderInstalled(): Promise<void> {
    const commands: Record<TunnelProvider, string> = {
      ngrok: "ngrok version",
      tailscale: "tailscale version",
      cloudflare: "cloudflared version",
      localtunnel: "lt --version",
    };

    const command = commands[this.config.provider];

    try {
      execSync(command, { encoding: "utf-8", stdio: "pipe" });
    } catch {
      const installInstructions: Record<TunnelProvider, string> = {
        ngrok: "Install ngrok: brew install ngrok (macOS) or download from https://ngrok.com",
        tailscale: "Install Tailscale: https://tailscale.com/download",
        cloudflare: "Install cloudflared: brew install cloudflare/cloudflare/cloudflared",
        localtunnel: "Install localtunnel: npm install -g localtunnel",
      };

      throw new Error(
        `${this.config.provider} is not installed. ${installInstructions[this.config.provider]}`,
      );
    }
  }

  /**
   * Start ngrok tunnel
   */
  private async startNgrok(): Promise<string> {
    // If auth token provided, configure it first
    if (this.config.ngrokAuthToken) {
      try {
        execSync(`ngrok config add-authtoken ${this.config.ngrokAuthToken}`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        // Ignore if already configured
      }
    }

    const args = ["http", `${this.config.host}:${this.config.port}`];

    if (this.config.ngrokRegion) {
      args.push("--region", this.config.ngrokRegion);
    }

    if (this.config.ngrokSubdomain) {
      args.push("--subdomain", this.config.ngrokSubdomain);
    }

    // Start ngrok process
    this.process = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.setupProcessHandlers();

    // Wait for ngrok to start and get URL from API
    return this.waitForNgrokUrl();
  }

  /**
   * Wait for ngrok to start and get URL from local API
   */
  private async waitForNgrokUrl(): Promise<string> {
    const maxAttempts = 30;
    const delay = 500;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await this.httpGet("http://127.0.0.1:4040/api/tunnels");
        const data = JSON.parse(response);

        if (data.tunnels && data.tunnels.length > 0) {
          const tunnel =
            data.tunnels.find((t: { proto: string }) => t.proto === "https") || data.tunnels[0];
          return tunnel.public_url;
        }
      } catch {
        // ngrok API not ready yet
      }

      await this.sleep(delay);
    }

    throw new Error("Timeout waiting for ngrok to start");
  }

  /**
   * Start Tailscale Funnel
   */
  private async startTailscale(): Promise<string> {
    // Check if Tailscale is connected
    try {
      const status = execSync("tailscale status --json", { encoding: "utf-8" });
      const statusData = JSON.parse(status);

      if (!statusData.Self?.Online) {
        throw new Error("Tailscale is not connected. Run: tailscale up");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not connected")) {
        throw error;
      }
      throw new Error("Failed to check Tailscale status");
    }

    // Enable funnel for the port
    const args = ["funnel", `${this.config.port}`];

    this.process = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.setupProcessHandlers();

    // Get the funnel URL
    return this.getTailscaleFunnelUrl();
  }

  /**
   * Get Tailscale Funnel URL
   */
  private async getTailscaleFunnelUrl(): Promise<string> {
    try {
      const status = execSync("tailscale status --json", { encoding: "utf-8" });
      const statusData = JSON.parse(status);
      const hostname =
        statusData.Self?.DNSName?.replace(/\.$/, "") || this.config.tailscaleHostname;

      if (!hostname) {
        throw new Error("Could not determine Tailscale hostname");
      }

      return `https://${hostname}:${this.config.port}`;
    } catch {
      throw new Error("Failed to get Tailscale Funnel URL");
    }
  }

  /**
   * Start Cloudflare Tunnel
   */
  private async startCloudflare(): Promise<string> {
    const args = ["tunnel"];

    if (this.config.cloudflareCredentialsFile) {
      args.push("--credentials-file", this.config.cloudflareCredentialsFile);
    }

    if (this.config.cloudflareTunnelName) {
      args.push("run", this.config.cloudflareTunnelName);
    } else {
      // Quick tunnel (no account required)
      args.push("--url", `http://${this.config.host}:${this.config.port}`);
    }

    this.process = spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.setupProcessHandlers();

    // Parse URL from output
    return this.waitForCloudflareUrl();
  }

  /**
   * Wait for Cloudflare tunnel URL from output
   */
  private async waitForCloudflareUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for Cloudflare tunnel URL"));
      }, 30000);

      const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

      const handleData = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(urlPattern);
        if (match) {
          clearTimeout(timeout);
          this.process?.stdout?.off("data", handleData);
          this.process?.stderr?.off("data", handleData);
          resolve(match[0]);
        }
      };

      this.process?.stdout?.on("data", handleData);
      this.process?.stderr?.on("data", handleData);
    });
  }

  /**
   * Start localtunnel
   */
  private async startLocaltunnel(): Promise<string> {
    const args = ["--port", this.config.port.toString()];

    if (this.config.host !== "localhost") {
      args.push("--local-host", this.config.host);
    }

    this.process = spawn("lt", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.setupProcessHandlers();

    // Parse URL from output
    return this.waitForLocaltunnelUrl();
  }

  /**
   * Wait for localtunnel URL from output
   */
  private async waitForLocaltunnelUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for localtunnel URL"));
      }, 30000);

      const urlPattern = /https:\/\/[a-z0-9-]+\.loca\.lt/;

      const handleData = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(urlPattern);
        if (match) {
          clearTimeout(timeout);
          this.process?.stdout?.off("data", handleData);
          resolve(match[0]);
        }
      };

      this.process?.stdout?.on("data", handleData);
    });
  }

  /**
   * Set up process event handlers
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      if (this._status === "running" && this.config.autoRestart) {
        console.log(`Tunnel process exited (code: ${code}, signal: ${signal}), restarting...`);
        this._status = "stopped";
        this.scheduleRestart();
      }
    });

    this.process.on("error", (error) => {
      console.error("Tunnel process error:", error);
      this._status = "error";
      this._error = error.message;
      this.emit("error", error);

      if (this.config.autoRestart) {
        this.scheduleRestart();
      }
    });

    if (this.config.verbose && this.process.stderr) {
      this.process.stderr.on("data", (data) => {
        console.log(`[${this.config.provider}]`, data.toString().trim());
      });
    }
  }

  /**
   * Schedule a restart
   */
  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined;
      try {
        await this.start();
      } catch (error) {
        console.error("Failed to restart tunnel:", error);
        this.scheduleRestart();
      }
    }, this.config.restartDelay);
  }

  /**
   * Simple HTTP GET request
   */
  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;

      const request = client.get(url, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve(data);
        });
      });

      request.on("error", reject);
      request.setTimeout(5000, () => {
        request.destroy();
        reject(new Error("Request timeout"));
      });
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Check which tunnel providers are available
 */
export async function getAvailableTunnelProviders(): Promise<TunnelProvider[]> {
  const providers: TunnelProvider[] = [];
  const commands: Record<TunnelProvider, string> = {
    ngrok: "ngrok version",
    tailscale: "tailscale version",
    cloudflare: "cloudflared version",
    localtunnel: "lt --version",
  };

  for (const [provider, command] of Object.entries(commands) as [TunnelProvider, string][]) {
    try {
      execSync(command, { encoding: "utf-8", stdio: "pipe" });
      providers.push(provider);
    } catch {
      // Provider not installed
    }
  }

  return providers;
}

/**
 * Create a tunnel with auto-detection of available provider
 */
export async function createAutoTunnel(
  port: number,
  preferredProvider?: TunnelProvider,
): Promise<TunnelManager> {
  const available = await getAvailableTunnelProviders();

  if (available.length === 0) {
    throw new Error(
      "No tunnel providers installed. Install ngrok, Tailscale, cloudflared, or localtunnel.",
    );
  }

  let provider = preferredProvider;
  if (!provider || !available.includes(provider)) {
    // Priority: ngrok > tailscale > cloudflare > localtunnel
    const priority: TunnelProvider[] = ["ngrok", "tailscale", "cloudflare", "localtunnel"];
    provider = priority.find((p) => available.includes(p))!;
  }

  return new TunnelManager({ provider, port });
}
