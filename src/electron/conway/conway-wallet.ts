/**
 * Conway Wallet Manager
 *
 * Generates and manages the Conway Terminal wallet with the private key
 * stored encrypted in SecureSettingsRepository (OS keychain-backed).
 *
 * The plaintext file at ~/.conway/wallet.json is written from the encrypted
 * store so Conway's MCP server can read it. If the file is deleted or tampered
 * with, it can be restored from the encrypted backup.
 *
 * Security model:
 * - Source of truth: encrypted database (SecureSettingsRepository, 'conway-wallet')
 * - Plaintext file: derived artifact, written only when needed
 * - Private key never leaves this module except to write the file
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { ethers } from "ethers";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const execAsync = promisify(exec);

const CONWAY_DIR = path.join(os.homedir(), ".conway");
const WALLET_FILE = path.join(CONWAY_DIR, "wallet.json");
const STORAGE_KEY = "conway-wallet" as const;

interface EncryptedWalletData {
  privateKey: string;
  address: string;
  network: string;
  createdAt: string;
  /** Conway API key obtained from --provision */
  apiKey?: string;
}

interface WalletFileFormat {
  privateKey: string;
  createdAt: string;
}

export class ConwayWalletManager {
  /**
   * Generate a new wallet, store encrypted, and write the file.
   * Returns the public address.
   */
  static generate(): { address: string; privateKey: string } {
    const wallet = ethers.Wallet.createRandom();

    const data: EncryptedWalletData = {
      privateKey: wallet.privateKey,
      address: wallet.address,
      network: "base",
      createdAt: new Date().toISOString(),
    };

    // Save to encrypted database first (source of truth)
    this.saveToEncryptedStore(data);

    // Write plaintext file for Conway MCP server
    this.writeWalletFile(data);

    console.log(`[ConwayWallet] Generated new wallet: ${wallet.address}`);
    return { address: wallet.address, privateKey: wallet.privateKey };
  }

  /**
   * Check if we have a wallet in the encrypted store
   */
  static hasWallet(): boolean {
    return this.loadFromEncryptedStore() !== null;
  }

  /**
   * Get the wallet address from encrypted store
   */
  static getAddress(): string | null {
    const data = this.loadFromEncryptedStore();
    return data?.address || null;
  }

  /**
   * Get the wallet network from encrypted store
   */
  static getNetwork(): string {
    const data = this.loadFromEncryptedStore();
    return data?.network || "base";
  }

  /**
   * Get full wallet info (public data only) from encrypted store
   */
  static getWalletInfo(): { address: string; network: string; createdAt: string } | null {
    const data = this.loadFromEncryptedStore();
    if (!data) return null;
    return {
      address: data.address,
      network: data.network,
      createdAt: data.createdAt,
    };
  }

  /**
   * Provision the wallet with Conway's API to get an API key.
   * Runs `npx conway-terminal --provision` and stores the key encrypted.
   */
  static async provision(): Promise<string | null> {
    try {
      const { stdout } = await execAsync("npx -y conway-terminal --provision", {
        timeout: 60000,
        env: { ...process.env, NODE_ENV: "production" },
      });

      const result = JSON.parse(stdout.trim());
      if (!result.apiKey) {
        console.warn("[ConwayWallet] Provision response missing apiKey");
        return null;
      }

      // Save API key into the encrypted wallet data
      const stored = this.loadFromEncryptedStore();
      if (stored) {
        stored.apiKey = result.apiKey;
        this.saveToEncryptedStore(stored);
        console.log("[ConwayWallet] API key provisioned and stored encrypted");
      }

      return result.apiKey;
    } catch (error) {
      console.warn("[ConwayWallet] Provisioning failed:", error);
      return null;
    }
  }

  /**
   * Get the stored Conway API key from encrypted database
   */
  static getApiKey(): string | null {
    const data = this.loadFromEncryptedStore();
    return data?.apiKey || null;
  }

  /**
   * Check if we have a provisioned API key
   */
  static hasApiKey(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Check if the plaintext wallet file exists on disk
   */
  static walletFileExists(): boolean {
    return fs.existsSync(WALLET_FILE);
  }

  /**
   * Verify integrity: encrypted store matches plaintext file.
   * Returns 'ok', 'file_missing', 'file_tampered', or 'no_wallet'.
   */
  static verifyIntegrity(): "ok" | "file_missing" | "file_tampered" | "no_wallet" {
    const stored = this.loadFromEncryptedStore();
    if (!stored) return "no_wallet";

    if (!this.walletFileExists()) return "file_missing";

    try {
      const fileContent = fs.readFileSync(WALLET_FILE, "utf-8");
      const fileData: WalletFileFormat = JSON.parse(fileContent);

      if (fileData.privateKey !== stored.privateKey) {
        return "file_tampered";
      }

      return "ok";
    } catch {
      return "file_tampered";
    }
  }

  /**
   * Restore the plaintext wallet file from the encrypted store.
   * Use when the file is missing or tampered.
   */
  static restoreWalletFile(): boolean {
    const stored = this.loadFromEncryptedStore();
    if (!stored) {
      console.error("[ConwayWallet] Cannot restore — no wallet in encrypted store");
      return false;
    }

    this.writeWalletFile(stored);
    console.log("[ConwayWallet] Restored wallet file from encrypted backup");
    return true;
  }

  /**
   * Import an existing wallet file into the encrypted store.
   * Use when migrating from a wallet created by `npx conway-terminal --init`.
   */
  static importFromFile(): boolean {
    if (!this.walletFileExists()) {
      console.error("[ConwayWallet] No wallet file to import");
      return false;
    }

    try {
      const fileContent = fs.readFileSync(WALLET_FILE, "utf-8");
      const fileData: WalletFileFormat = JSON.parse(fileContent);

      if (!fileData.privateKey || !fileData.privateKey.startsWith("0x")) {
        console.error("[ConwayWallet] Invalid wallet file format");
        return false;
      }

      // Derive address from the private key
      const wallet = new ethers.Wallet(fileData.privateKey);

      const data: EncryptedWalletData = {
        privateKey: fileData.privateKey,
        address: wallet.address,
        network: "base",
        createdAt: fileData.createdAt || new Date().toISOString(),
      };

      this.saveToEncryptedStore(data);
      // Tighten file permissions
      this.ensureFilePermissions();

      console.log(`[ConwayWallet] Imported existing wallet: ${wallet.address}`);
      return true;
    } catch (error) {
      console.error("[ConwayWallet] Failed to import wallet file:", error);
      return false;
    }
  }

  /**
   * Ensure the wallet file has secure permissions (0600 — owner read/write only)
   */
  static ensureFilePermissions(): void {
    try {
      if (!this.walletFileExists()) return;
      const stats = fs.statSync(WALLET_FILE);
      const mode = stats.mode & 0o777;
      if (mode & 0o077) {
        fs.chmodSync(WALLET_FILE, 0o600);
        console.log("[ConwayWallet] Tightened wallet file permissions to 0600");
      }
    } catch (error) {
      console.warn("[ConwayWallet] Could not set file permissions:", error);
    }
  }

  /**
   * Full startup check: verify integrity, import/restore as needed.
   * Returns the wallet address if available, null otherwise.
   */
  static startupCheck(): { address: string | null; status: string } {
    const hasEncrypted = this.hasWallet();
    const hasFile = this.walletFileExists();

    // Case 1: We have both — verify they match
    if (hasEncrypted && hasFile) {
      const integrity = this.verifyIntegrity();
      if (integrity === "ok") {
        this.ensureFilePermissions();
        return { address: this.getAddress(), status: "ok" };
      }
      if (integrity === "file_tampered") {
        console.warn(
          "[ConwayWallet] Wallet file was tampered with — restoring from encrypted backup",
        );
        this.restoreWalletFile();
        return { address: this.getAddress(), status: "restored_from_backup" };
      }
    }

    // Case 2: Encrypted store only, file missing — restore it
    if (hasEncrypted && !hasFile) {
      console.warn("[ConwayWallet] Wallet file missing — restoring from encrypted backup");
      this.restoreWalletFile();
      return { address: this.getAddress(), status: "restored_from_backup" };
    }

    // Case 3: File only, no encrypted backup — import it (migration from npx conway-terminal --init)
    if (!hasEncrypted && hasFile) {
      console.log("[ConwayWallet] Found existing wallet file — importing into encrypted store");
      if (this.importFromFile()) {
        return { address: this.getAddress(), status: "imported_from_file" };
      }
      return { address: null, status: "import_failed" };
    }

    // Case 4: Neither exists — no wallet yet
    return { address: null, status: "no_wallet" };
  }

  // --- Private helpers ---

  private static saveToEncryptedStore(data: EncryptedWalletData): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized — cannot store wallet");
    }
    const repository = SecureSettingsRepository.getInstance();
    repository.save(STORAGE_KEY, data);
  }

  private static loadFromEncryptedStore(): EncryptedWalletData | null {
    try {
      if (!SecureSettingsRepository.isInitialized()) return null;
      const repository = SecureSettingsRepository.getInstance();
      return repository.load<EncryptedWalletData>(STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  private static writeWalletFile(data: EncryptedWalletData): void {
    // Ensure directory exists
    if (!fs.existsSync(CONWAY_DIR)) {
      fs.mkdirSync(CONWAY_DIR, { mode: 0o700, recursive: true });
    }

    const fileData: WalletFileFormat = {
      privateKey: data.privateKey,
      createdAt: data.createdAt,
    };

    fs.writeFileSync(WALLET_FILE, JSON.stringify(fileData, null, 2), {
      mode: 0o600,
      encoding: "utf-8",
    });
  }
}
