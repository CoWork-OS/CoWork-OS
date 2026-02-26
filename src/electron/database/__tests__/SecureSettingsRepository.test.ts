/**
 * Unit tests for SecureSettingsRepository
 *
 * Tests encrypted settings storage with both OS keychain and app-level encryption
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

const ORIGINAL_COWORK_USER_DATA_DIR = process.env.COWORK_USER_DATA_DIR;

// Mock safeStorage (via our helper) and electron app (for any incidental app path usage)
const mockEncryptString = vi.fn();
const mockDecryptString = vi.fn();
const mockIsEncryptionAvailable = vi.fn();

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    encryptString: (data: string) => mockEncryptString(data),
    decryptString: (buffer: Buffer) => mockDecryptString(buffer),
    isEncryptionAvailable: () => mockIsEncryptionAvailable(),
  }),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/mock/user/data"),
  },
}));

// Mock fs for machine ID file operations
const mockFsExistsSync = vi.fn();
const mockFsReadFileSync = vi.fn();
const mockFsWriteFileSync = vi.fn();

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
}));

// Mock uuid
vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

// Mock os module
vi.mock("os", () => ({
  hostname: vi.fn(() => "test-hostname"),
  platform: vi.fn(() => "darwin"),
  arch: vi.fn(() => "arm64"),
  homedir: vi.fn(() => "/Users/testuser"),
}));

import type { SettingsCategory } from "../SecureSettingsRepository";

// This test suite relies on module mocking. Since Vitest may reuse module caches across test files,
// we dynamically import the module under test after applying mocks to ensure a clean copy.
let SecureSettingsRepositoryClass: typeof import("../SecureSettingsRepository").SecureSettingsRepository;

describe("SecureSettingsRepository", () => {
  let mockDb: Database.Database;
  let mockStmt: {
    run: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
  };
  let repository: Any;

  beforeEach(async () => {
    // Ensure getUserDataDir() resolves to our mock path in non-Electron unit tests.
    process.env.COWORK_USER_DATA_DIR = "/mock/user/data";

    // Reset all mocks
    vi.clearAllMocks();

    // Create mock statement
    mockStmt = {
      run: vi.fn(() => ({ changes: 1 })),
      get: vi.fn(),
      all: vi.fn(() => []),
    };

    // Create mock database
    mockDb = {
      prepare: vi.fn(() => mockStmt),
    } as unknown as Database.Database;

    // Default: OS encryption available
    mockIsEncryptionAvailable.mockReturnValue(true);

    // Mock safeStorage encrypt/decrypt
    mockEncryptString.mockImplementation((data: string) => {
      return Buffer.from(`encrypted:${data}`);
    });
    mockDecryptString.mockImplementation((buffer: Buffer) => {
      const str = buffer.toString();
      if (str.startsWith("encrypted:")) {
        return str.slice(10);
      }
      throw new Error("Invalid encrypted data");
    });

    // Default: No existing machine ID file (will generate new one)
    mockFsExistsSync.mockReturnValue(false);
    mockFsWriteFileSync.mockImplementation(() => {});

    // Force a fresh import so the safe-storage mock is always applied.
    vi.resetModules();
    const mod = await import("../SecureSettingsRepository");
    SecureSettingsRepositoryClass = mod.SecureSettingsRepository;

    // Reset singleton
    (SecureSettingsRepositoryClass as Any).instance = null;
  });

  afterEach(() => {
    if (ORIGINAL_COWORK_USER_DATA_DIR === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = ORIGINAL_COWORK_USER_DATA_DIR;
    }

    // Clean up singleton
    (SecureSettingsRepositoryClass as Any).instance = null;
  });

  describe("constructor and singleton", () => {
    it("should create instance and set as singleton", () => {
      repository = new SecureSettingsRepositoryClass(mockDb);

      expect(SecureSettingsRepositoryClass.isInitialized()).toBe(true);
      expect(SecureSettingsRepositoryClass.getInstance()).toBe(repository);
    });

    it("should throw when getInstance called before initialization", () => {
      expect(() => SecureSettingsRepositoryClass.getInstance()).toThrow(
        "SecureSettingsRepository has not been initialized",
      );
    });

    it("should return false from isInitialized before construction", () => {
      expect(SecureSettingsRepositoryClass.isInitialized()).toBe(false);
    });

    it("should warn when OS encryption is not available", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockIsEncryptionAvailable.mockReturnValue(false);

      repository = new SecureSettingsRepositoryClass(mockDb);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("OS encryption not available"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("save()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should insert new settings when none exist", () => {
      mockStmt.get.mockReturnValue(undefined); // No existing settings

      const testSettings = { provider: "azure", apiKey: "test-key" };
      repository.save("voice", testSettings);

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO"));
      expect(mockStmt.run).toHaveBeenCalledWith(
        "test-uuid-1234",
        "voice",
        expect.stringContaining("os:"), // OS encryption prefix
        expect.any(String), // checksum
        expect.any(Number), // created_at
        expect.any(Number), // updated_at
      );
    });

    it("should update existing settings", () => {
      mockStmt.get.mockReturnValue({
        id: "existing-id",
        category: "voice",
        encrypted_data: "os:old-data",
        checksum: "old-checksum",
        created_at: 1000,
        updated_at: 1000,
      });

      const testSettings = { provider: "elevenlabs" };
      repository.save("voice", testSettings);

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE"));
      expect(mockStmt.run).toHaveBeenCalledWith(
        expect.stringContaining("os:"), // encrypted data
        expect.any(String), // checksum
        expect.any(Number), // updated_at
        "voice",
      );
    });

    it("should encrypt data using OS keychain when available", () => {
      mockStmt.get.mockReturnValue(undefined);

      repository.save("llm", { model: "gpt-4" });

      expect(mockEncryptString).toHaveBeenCalledWith(JSON.stringify({ model: "gpt-4" }));
    });

    it("should use app-level encryption when OS keychain unavailable", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      (SecureSettingsRepositoryClass as Any).instance = null;
      repository = new SecureSettingsRepositoryClass(mockDb);
      mockStmt.get.mockReturnValue(undefined);

      repository.save("search", { provider: "brave" });

      // Should not call safeStorage
      expect(mockEncryptString).not.toHaveBeenCalled();

      // Should have inserted with app: prefix
      expect(mockStmt.run).toHaveBeenCalledWith(
        expect.any(String),
        "search",
        expect.stringMatching(/^app:/),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("should log save operation", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockStmt.get.mockReturnValue(undefined);

      repository.save("appearance", { theme: "dark" });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Saved settings for category: appearance"),
      );
      consoleSpy.mockRestore();
    });

    it("should handle plugin-scoped categories", () => {
      mockStmt.get.mockReturnValue(undefined);

      repository.save("plugin:my-plugin", { apiKey: "super-secret" });

      expect(mockStmt.run).toHaveBeenCalledWith(
        "test-uuid-1234",
        "plugin:my-plugin",
        expect.stringContaining("os:"),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  describe("load()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return undefined when no settings exist", () => {
      mockStmt.get.mockReturnValue(undefined);

      const result = repository.load("voice");

      expect(result).toBeUndefined();
    });

    it("should decrypt and return settings with valid checksum", () => {
      const testData = { provider: "azure", endpoint: "https://test.api" };
      const jsonData = JSON.stringify(testData);
// oxlint-disable-next-line typescript-eslint(no-require-imports)
      const crypto = require("crypto");
      const checksum = crypto.createHash("sha256").update(jsonData).digest("hex");

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: `os:${Buffer.from(`encrypted:${jsonData}`).toString("base64")}`,
        checksum: checksum,
        created_at: 1000,
        updated_at: 2000,
      });

      mockDecryptString.mockReturnValue(jsonData);

      const result = repository.load("voice");

      expect(result).toEqual(testData);
    });

    it("should return undefined on checksum mismatch", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const testData = { provider: "azure" };

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: `os:${Buffer.from(`encrypted:${JSON.stringify(testData)}`).toString("base64")}`,
        checksum: "wrong-checksum",
        created_at: 1000,
        updated_at: 2000,
      });

      mockDecryptString.mockReturnValue(JSON.stringify(testData));

      const result = repository.load("voice");

      expect(result).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Checksum mismatch"));
      consoleSpy.mockRestore();
    });

    it("should return undefined on decryption failure", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: "os:invalid-encrypted-data",
        checksum: "some-checksum",
        created_at: 1000,
        updated_at: 2000,
      });

      mockDecryptString.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const result = repository.load("voice");

      expect(result).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decrypt"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("delete()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should delete settings and return true when found", () => {
      mockStmt.run.mockReturnValue({ changes: 1 });

      const result = repository.delete("voice");

      expect(result).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE"));
      expect(mockStmt.run).toHaveBeenCalledWith("voice");
    });

    it("should return false when nothing to delete", () => {
      mockStmt.run.mockReturnValue({ changes: 0 });

      const result = repository.delete("voice");

      expect(result).toBe(false);
    });
  });

  describe("exists()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return true when settings exist", () => {
      mockStmt.get.mockReturnValue({ 1: 1 });

      const result = repository.exists("voice");

      expect(result).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("SELECT 1"));
    });

    it("should return false when no settings exist", () => {
      mockStmt.get.mockReturnValue(undefined);

      const result = repository.exists("llm");

      expect(result).toBe(false);
    });
  });

  describe("listCategories()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return all stored categories", () => {
      mockStmt.all.mockReturnValue([
        { category: "voice" },
        { category: "llm" },
        { category: "appearance" },
      ]);

      const result = repository.listCategories();

      expect(result).toEqual(["voice", "llm", "appearance"]);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT category FROM secure_settings"),
      );
    });

    it("should return empty array when no settings stored", () => {
      mockStmt.all.mockReturnValue([]);

      const result = repository.listCategories();

      expect(result).toEqual([]);
    });
  });

  describe("getMetadata()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return timestamps when settings exist", () => {
      mockStmt.get.mockReturnValue({
        created_at: 1000000,
        updated_at: 2000000,
      });

      const result = repository.getMetadata("voice");

      expect(result).toEqual({
        createdAt: 1000000,
        updatedAt: 2000000,
      });
    });

    it("should return undefined when no settings exist", () => {
      mockStmt.get.mockReturnValue(undefined);

      const result = repository.getMetadata("llm");

      expect(result).toBeUndefined();
    });
  });

  describe("encryption modes", () => {
    it("should use OS encryption prefix when available", () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      repository = new SecureSettingsRepositoryClass(mockDb);
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "data" });

      const runCall = mockStmt.run.mock.calls[0];
      expect(runCall[2]).toMatch(/^os:/);
    });

    it("should use app encryption prefix when OS unavailable", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      repository = new SecureSettingsRepositoryClass(mockDb);
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "data" });

      const runCall = mockStmt.run.mock.calls[0];
      expect(runCall[2]).toMatch(/^app:/);
    });

    it("should handle app-encrypted data on load (round-trip)", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      (SecureSettingsRepositoryClass as Any).instance = null;
      repository = new SecureSettingsRepositoryClass(mockDb);

      const testData = { provider: "test" };

      // First, save the data to capture what encrypted string is produced
      mockStmt.get.mockReturnValue(undefined);
      repository.save("voice", testData);

      // Get the encrypted data and checksum from the save call
      const saveCall = mockStmt.run.mock.calls[0];
      const savedEncryptedData = saveCall[2];
      const savedChecksum = saveCall[3];

      // Verify it uses app: prefix
      expect(savedEncryptedData).toMatch(/^app:/);

      // Now set up mock to return this encrypted data
      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: savedEncryptedData,
        checksum: savedChecksum,
        created_at: 1000,
        updated_at: 2000,
      });

      // Load and verify round-trip works
      const result = repository.load("voice");

      expect(result).toEqual(testData);
    });

    it("should throw when OS encryption was used but is no longer available", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      repository = new SecureSettingsRepositoryClass(mockDb);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: "os:some-encrypted-data",
        checksum: "checksum",
        created_at: 1000,
        updated_at: 2000,
      });

      const result = repository.load("voice");

      expect(result).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decrypt"),
        expect.objectContaining({
          message: "OS encryption was used but is no longer available",
        }),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("data integrity", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should compute consistent checksum for same data", () => {
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "value" });
      const firstChecksum = mockStmt.run.mock.calls[0][3];

      vi.clearAllMocks();
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "value" });
      const secondChecksum = mockStmt.run.mock.calls[0][3];

      expect(firstChecksum).toBe(secondChecksum);
    });

    it("should produce different checksum for different data", () => {
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "value1" });
      const firstChecksum = mockStmt.run.mock.calls[0][3];

      vi.clearAllMocks();
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "value2" });
      const secondChecksum = mockStmt.run.mock.calls[0][3];

      expect(firstChecksum).not.toBe(secondChecksum);
    });
  });

  describe("all settings categories", () => {
    const categories: SettingsCategory[] = [
      "voice",
      "llm",
      "search",
      "appearance",
      "personality",
      "guardrails",
      "hooks",
      "mcp",
      "controlplane",
      "channels",
      "builtintools",
      "tailscale",
      "claude-auth",
      "x",
    ];

    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it.each(categories)("should handle category: %s", (category) => {
      mockStmt.get.mockReturnValue(undefined);

      const testData = { categoryTest: category };
      repository.save(category, testData);

      expect(mockStmt.run).toHaveBeenCalledWith(
        expect.any(String),
        category,
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  describe("stable machine ID", () => {
    it("should generate and persist machine ID on first run", () => {
      mockFsExistsSync.mockReturnValue(false);

      repository = new SecureSettingsRepositoryClass(mockDb);

      expect(mockFsWriteFileSync).toHaveBeenCalledWith(
        "/mock/user/data/.cowork-machine-id",
        "test-uuid-1234",
        { mode: 0o600 },
      );
    });

    it("should load existing machine ID", () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue("existing-machine-id-uuid");

      repository = new SecureSettingsRepositoryClass(mockDb);

      expect(mockFsWriteFileSync).not.toHaveBeenCalled();
      expect(mockFsReadFileSync).toHaveBeenCalledWith(
        "/mock/user/data/.cowork-machine-id",
        "utf-8",
      );
    });

    it("should use stable machine ID for app encryption", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue("stable-machine-id");
      (SecureSettingsRepositoryClass as Any).instance = null;

      repository = new SecureSettingsRepositoryClass(mockDb);
      mockStmt.get.mockReturnValue(undefined);

      repository.save("voice", { test: "data" });

      // Should use app: prefix for encryption
      const runCall = mockStmt.run.mock.calls[0];
      expect(runCall[2]).toMatch(/^app:/);
    });
  });

  describe("loadWithStatus()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return not_found status when no settings exist", () => {
      mockStmt.get.mockReturnValue(undefined);

      const result = repository.loadWithStatus("voice");

      expect(result.status).toBe("not_found");
      expect(result.data).toBeUndefined();
    });

    it("should return success status with data on successful load", () => {
      const testData = { provider: "azure" };
      const jsonData = JSON.stringify(testData);
// oxlint-disable-next-line typescript-eslint(no-require-imports)
      const crypto = require("crypto");
      const checksum = crypto.createHash("sha256").update(jsonData).digest("hex");

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: `os:${Buffer.from(`encrypted:${jsonData}`).toString("base64")}`,
        checksum: checksum,
        created_at: 1000,
        updated_at: 2000,
      });
      mockDecryptString.mockReturnValue(jsonData);

      const result = repository.loadWithStatus("voice");

      expect(result.status).toBe("success");
      expect(result.data).toEqual(testData);
    });

    it("should return checksum_mismatch status on corrupted data", () => {
      const testData = { provider: "azure" };
      const jsonData = JSON.stringify(testData);

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: `os:${Buffer.from(`encrypted:${jsonData}`).toString("base64")}`,
        checksum: "wrong-checksum",
        created_at: 1000,
        updated_at: 2000,
      });
      mockDecryptString.mockReturnValue(jsonData);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = repository.loadWithStatus("voice");

      expect(result.status).toBe("checksum_mismatch");
      expect(result.error).toContain("integrity check failed");
      consoleSpy.mockRestore();
    });

    it("should return os_encryption_unavailable status when OS encryption lost", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      (SecureSettingsRepositoryClass as Any).instance = null;
      repository = new SecureSettingsRepositoryClass(mockDb);

      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: "os:some-encrypted-data",
        checksum: "checksum",
        created_at: 1000,
        updated_at: 2000,
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = repository.loadWithStatus("voice");

      expect(result.status).toBe("os_encryption_unavailable");
      expect(result.error).toContain("OS keychain");
      consoleSpy.mockRestore();
    });

    it("should return decryption_failed status on other errors", () => {
      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: "os:invalid-data",
        checksum: "checksum",
        created_at: 1000,
        updated_at: 2000,
      });
      mockDecryptString.mockImplementation(() => {
        throw new Error("Some decryption error");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = repository.loadWithStatus("voice");

      expect(result.status).toBe("decryption_failed");
      expect(result.error).toContain("decryption error");
      consoleSpy.mockRestore();
    });
  });

  describe("checkHealth()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should return status without exposing data", () => {
      mockStmt.get.mockReturnValue(undefined);

      const status = repository.checkHealth("voice");

      expect(status).toBe("not_found");
    });
  });

  describe("deleteCorrupted()", () => {
    beforeEach(() => {
      repository = new SecureSettingsRepositoryClass(mockDb);
    });

    it("should delete settings when corrupted", () => {
      // Setup corrupted data
      mockStmt.get.mockReturnValue({
        id: "test-id",
        category: "voice",
        encrypted_data: "os:invalid",
        checksum: "wrong",
        created_at: 1000,
        updated_at: 2000,
      });
      mockDecryptString.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = repository.deleteCorrupted("voice");

      expect(result).toBe(true);
      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("should not delete when settings are healthy", () => {
      mockStmt.get.mockReturnValue(undefined); // not_found is not corrupted

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = repository.deleteCorrupted("voice");

      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });
});
