/**
 * Infrastructure Wallet Manager
 *
 * Generates and manages the crypto wallet with the private key
 * stored encrypted in SecureSettingsRepository (OS keychain-backed).
 *
 * Security model:
 * - Source of truth: encrypted database (SecureSettingsRepository, 'infra-wallet')
 * - Private key never leaves this module except through explicit getter
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ethers } from "ethers";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";

const WALLET_DIR = path.join(os.homedir(), ".cowork-os");
const _WALLET_FILE = path.join(WALLET_DIR, "wallet.json");
const STORAGE_KEY = "infra-wallet" as const;

interface EncryptedWalletData {
  privateKey: string;
  address: string;
  network: string;
  createdAt: string;
}

interface WalletFileFormat {
  privateKey: string;
  createdAt: string;
}

export class WalletManager {
  /**
   * Generate a new wallet, store encrypted, and return key info.
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

    console.log(`[WalletManager] Generated new wallet: ${wallet.address}`);
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
   * Get the wallet network
   */
  static getNetwork(): string {
    const data = this.loadFromEncryptedStore();
    return data?.network || "base";
  }

  /**
   * Get the private key (for signing). Use with extreme caution.
   */
  static getPrivateKey(): string | null {
    const data = this.loadFromEncryptedStore();
    return data?.privateKey || null;
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
   * Check if a legacy wallet file exists (~/.conway/wallet.json)
   */
  static legacyWalletFileExists(): boolean {
    const legacyFile = path.join(os.homedir(), ".conway", "wallet.json");
    return fs.existsSync(legacyFile);
  }

  /**
   * Import legacy wallet file into infra encrypted store
   */
  static importLegacyWallet(): boolean {
    const legacyFile = path.join(os.homedir(), ".conway", "wallet.json");
    if (!fs.existsSync(legacyFile)) return false;

    try {
      const fileContent = fs.readFileSync(legacyFile, "utf-8");
      const fileData: WalletFileFormat = JSON.parse(fileContent);

      if (!fileData.privateKey || !fileData.privateKey.startsWith("0x")) {
        console.error("[WalletManager] Invalid legacy wallet file format");
        return false;
      }

      const wallet = new ethers.Wallet(fileData.privateKey);
      const data: EncryptedWalletData = {
        privateKey: fileData.privateKey,
        address: wallet.address,
        network: "base",
        createdAt: fileData.createdAt || new Date().toISOString(),
      };

      this.saveToEncryptedStore(data);
      console.log(`[WalletManager] Imported legacy wallet: ${wallet.address}`);
      return true;
    } catch (error) {
      console.error("[WalletManager] Failed to import legacy wallet:", error);
      return false;
    }
  }

  /**
   * Try to migrate from the legacy encrypted store key ("conway-wallet")
   */
  static migrateFromLegacyEncryptedStore(): boolean {
    try {
      if (!SecureSettingsRepository.isInitialized()) return false;
      const repo = SecureSettingsRepository.getInstance();
      const legacyData = repo.load<EncryptedWalletData>("conway-wallet");
      if (!legacyData?.privateKey || !legacyData?.address) return false;

      // Already have infra wallet? Skip.
      if (this.hasWallet()) return false;

      const data: EncryptedWalletData = {
        privateKey: legacyData.privateKey,
        address: legacyData.address,
        network: legacyData.network || "base",
        createdAt: legacyData.createdAt || new Date().toISOString(),
      };

      this.saveToEncryptedStore(data);
      console.log(`[WalletManager] Migrated wallet from legacy encrypted store: ${data.address}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full startup check: look for existing wallet, migrate if needed.
   */
  static startupCheck(): { address: string | null; status: string } {
    // Already have a wallet in infra store
    if (this.hasWallet()) {
      return { address: this.getAddress(), status: "ok" };
    }

    // Try to migrate from legacy encrypted store
    if (this.migrateFromLegacyEncryptedStore()) {
      return { address: this.getAddress(), status: "migrated_from_legacy_store" };
    }

    // Try to import legacy wallet file
    if (this.legacyWalletFileExists() && this.importLegacyWallet()) {
      return { address: this.getAddress(), status: "imported_from_legacy_file" };
    }

    // No wallet yet
    return { address: null, status: "no_wallet" };
  }

  /**
   * Get USDC balance on Base network using public RPC
   */
  static async getBalance(): Promise<string> {
    const address = this.getAddress();
    if (!address) return "0.00";

    const RPC_URLS = ["https://mainnet.base.org", "https://base.llamarpc.com"];
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    for (const rpcUrl of RPC_URLS) {
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
          staticNetwork: true,
          batchMaxCount: 1,
        });
        const usdc = new ethers.Contract(
          USDC_ADDRESS,
          ["function balanceOf(address) view returns (uint256)"],
          provider,
        );
        const balance = await Promise.race([
          usdc.balanceOf(address),
          new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 10_000)),
        ]);
        // USDC has 6 decimals
        return ethers.formatUnits(balance, 6);
      } catch (error) {
        console.warn(`[WalletManager] Balance fetch failed (${rpcUrl}):`, error);
        continue;
      }
    }
    console.warn("[WalletManager] All RPC endpoints failed for balance fetch");
    return "0.00";
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
}
