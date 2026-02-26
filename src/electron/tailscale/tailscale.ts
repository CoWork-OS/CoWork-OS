/**
 * Tailscale CLI Integration
 *
 * Low-level utilities for interacting with the Tailscale CLI.
 * Handles binary detection, status queries, and Serve/Funnel management.
 */

import { execFile, exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Cache for binary path
let cachedBinaryPath: string | null = null;
let binarySearchAttempted = false;

// Cache for status with TTL
interface CachedStatus {
  data: TailscaleStatusJson | null;
  timestamp: number;
  error?: string;
}

let cachedStatus: CachedStatus | null = null;
const STATUS_CACHE_TTL_MS = 30_000; // 30 seconds
const STATUS_ERROR_CACHE_TTL_MS = 5_000; // 5 seconds for errors

/**
 * Tailscale status JSON structure (partial)
 */
export interface TailscaleStatusJson {
  Version: string;
  TUN: boolean;
  BackendState: string;
  AuthURL?: string;
  TailscaleIPs?: string[];
  Self?: {
    ID: string;
    UserID: number;
    HostName: string;
    DNSName: string;
    OS: string;
    Online: boolean;
    Capabilities?: string[];
  };
  MagicDNSSuffix?: string;
  CurrentTailnet?: {
    Name: string;
    MagicDNSSuffix: string;
    MagicDNSEnabled: boolean;
  };
}

/**
 * Common macOS paths where Tailscale might be installed
 */
const MACOS_TAILSCALE_PATHS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  path.join(process.env.HOME || "", "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
];

/**
 * Check if a file exists and is executable
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a Tailscale binary by running --version
 */
async function verifyTailscaleBinary(binaryPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      timeout: 3000,
    });
    return stdout.includes("tailscale") || stdout.includes("Tailscale");
  } catch {
    return false;
  }
}

/**
 * Find the Tailscale binary using multiple strategies
 *
 * 1. Check common macOS paths
 * 2. Try PATH lookup via 'which'
 * 3. Check if 'tailscale' works directly
 */
export async function findTailscaleBinary(): Promise<string | null> {
  // Return cached result if available
  if (cachedBinaryPath) {
    return cachedBinaryPath;
  }

  if (binarySearchAttempted && !cachedBinaryPath) {
    return null;
  }

  binarySearchAttempted = true;

  // Strategy 1: Check common macOS paths
  for (const candidatePath of MACOS_TAILSCALE_PATHS) {
    if (await isExecutable(candidatePath)) {
      if (await verifyTailscaleBinary(candidatePath)) {
        cachedBinaryPath = candidatePath;
        console.log("[Tailscale] Found binary at:", candidatePath);
        return candidatePath;
      }
    }
  }

  // Strategy 2: Try PATH lookup
  try {
    const { stdout } = await execAsync("which tailscale", { timeout: 3000 });
    const whichPath = stdout.trim();
    if (whichPath && (await isExecutable(whichPath))) {
      if (await verifyTailscaleBinary(whichPath)) {
        cachedBinaryPath = whichPath;
        console.log("[Tailscale] Found binary via which:", whichPath);
        return whichPath;
      }
    }
  } catch {
    // which failed, continue to next strategy
  }

  // Strategy 3: Just try 'tailscale' directly
  if (await verifyTailscaleBinary("tailscale")) {
    cachedBinaryPath = "tailscale";
    console.log("[Tailscale] Using tailscale from PATH");
    return "tailscale";
  }

  console.log("[Tailscale] Binary not found");
  return null;
}

/**
 * Get the Tailscale binary path, defaulting to 'tailscale' if not found
 */
export async function getTailscaleBinary(): Promise<string> {
  const binary = await findTailscaleBinary();
  return binary || "tailscale";
}

/**
 * Check if Tailscale is installed
 */
export async function isTailscaleInstalled(): Promise<boolean> {
  const binary = await findTailscaleBinary();
  return binary !== null;
}

/**
 * Parse JSON from potentially noisy output
 * Tailscale sometimes outputs warnings before the JSON
 */
function extractJson<T>(output: string): T | null {
  // Try to find JSON in the output
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get Tailscale status as JSON
 */
export async function getTailscaleStatus(): Promise<TailscaleStatusJson | null> {
  // Check cache
  if (cachedStatus) {
    const age = Date.now() - cachedStatus.timestamp;
    const ttl = cachedStatus.error ? STATUS_ERROR_CACHE_TTL_MS : STATUS_CACHE_TTL_MS;
    if (age < ttl) {
      return cachedStatus.data;
    }
  }

  const binary = await getTailscaleBinary();

  try {
    const { stdout } = await execFileAsync(binary, ["status", "--json"], {
      timeout: 10000,
    });

    const status = extractJson<TailscaleStatusJson>(stdout);
    cachedStatus = {
      data: status,
      timestamp: Date.now(),
    };
    return status;
  } catch (error: Any) {
    console.error("[Tailscale] Failed to get status:", error.message || error);
    cachedStatus = {
      data: null,
      timestamp: Date.now(),
      error: error.message || String(error),
    };
    return null;
  }
}

/**
 * Get the Tailnet hostname for this device
 * Returns the DNS name (e.g., "my-macbook.tail1234.ts.net") or IP
 */
export async function getTailnetHostname(): Promise<string | null> {
  const status = await getTailscaleStatus();
  if (!status) return null;

  // Prefer DNS name
  if (status.Self?.DNSName) {
    // Remove trailing dot if present
    return status.Self.DNSName.replace(/\.$/, "");
  }

  // Fallback to first Tailscale IP
  if (status.TailscaleIPs && status.TailscaleIPs.length > 0) {
    return status.TailscaleIPs[0];
  }

  return null;
}

/**
 * Execute a Tailscale command with optional sudo fallback
 */
async function execTailscaleCommand(
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const binary = await getTailscaleBinary();
  const timeout = options?.timeout || 30000;

  try {
    return await execFileAsync(binary, args, { timeout });
  } catch (error: Any) {
    // Check if it's a permission error
    const stderr = error.stderr || "";
    const message = error.message || "";

    if (
      stderr.includes("permission denied") ||
      stderr.includes("Operation not permitted") ||
      message.includes("permission denied") ||
      message.includes("EPERM")
    ) {
      console.log("[Tailscale] Retrying with sudo...");

      // Try with sudo
      const command = `sudo ${binary} ${args.map((a) => `"${a}"`).join(" ")}`;
      return await execAsync(command, { timeout });
    }

    throw error;
  }
}

/**
 * Enable Tailscale Serve for a local port
 *
 * @param port - Local port to expose
 * @param path - URL path (default: "/")
 * @returns true if successful
 */
export async function enableTailscaleServe(port: number, urlPath = "/"): Promise<boolean> {
  try {
    const target = `http://127.0.0.1:${port}${urlPath}`;

    // Use --bg to run in background, --yes to skip confirmation
    await execTailscaleCommand(["serve", "--bg", "--yes", target]);

    console.log(`[Tailscale] Serve enabled for ${target}`);

    // Clear status cache to reflect new state
    cachedStatus = null;
    return true;
  } catch (error: Any) {
    console.error("[Tailscale] Failed to enable Serve:", error.message || error);
    return false;
  }
}

/**
 * Disable Tailscale Serve
 *
 * @returns true if successful
 */
export async function disableTailscaleServe(): Promise<boolean> {
  try {
    await execTailscaleCommand(["serve", "reset"]);
    console.log("[Tailscale] Serve disabled");
    cachedStatus = null;
    return true;
  } catch (error: Any) {
    console.error("[Tailscale] Failed to disable Serve:", error.message || error);
    return false;
  }
}

/**
 * Enable Tailscale Funnel for a local port
 *
 * @param port - Local port to expose
 * @param path - URL path (default: "/")
 * @returns true if successful
 */
export async function enableTailscaleFunnel(port: number, urlPath = "/"): Promise<boolean> {
  try {
    const target = `http://127.0.0.1:${port}${urlPath}`;

    // Use --bg to run in background, --yes to skip confirmation
    await execTailscaleCommand(["funnel", "--bg", "--yes", target]);

    console.log(`[Tailscale] Funnel enabled for ${target}`);
    cachedStatus = null;
    return true;
  } catch (error: Any) {
    console.error("[Tailscale] Failed to enable Funnel:", error.message || error);
    return false;
  }
}

/**
 * Disable Tailscale Funnel
 *
 * @returns true if successful
 */
export async function disableTailscaleFunnel(): Promise<boolean> {
  try {
    await execTailscaleCommand(["funnel", "reset"]);
    console.log("[Tailscale] Funnel disabled");
    cachedStatus = null;
    return true;
  } catch (error: Any) {
    console.error("[Tailscale] Failed to disable Funnel:", error.message || error);
    return false;
  }
}

/**
 * Check if Tailscale Funnel is available for this account
 * (Funnel requires certain Tailscale plans/features)
 */
export async function checkTailscaleFunnelAvailable(): Promise<boolean> {
  const status = await getTailscaleStatus();
  if (!status) return false;

  // Check capabilities
  const capabilities = status.Self?.Capabilities || [];
  return capabilities.some((cap) => cap.includes("funnel") || cap.includes("https"));
}

/**
 * Clear all caches (useful for testing or when config changes)
 */
export function clearTailscaleCache(): void {
  cachedBinaryPath = null;
  binarySearchAttempted = false;
  cachedStatus = null;
}
