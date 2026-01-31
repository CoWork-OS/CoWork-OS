/**
 * Tests for MCP Settings Manager - batch mode for startup optimization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Track writes manually since mocking fs can be complex
let writeCount = 0;

// Mock fs module entirely
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn().mockImplementation(() => {
      writeCount++;
    }),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn().mockImplementation(() => {
    writeCount++;
  }),
  mkdirSync: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// Import after mocking
import { MCPSettingsManager } from '../settings';

describe('MCPSettingsManager batch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCount = 0;
    MCPSettingsManager.clearCache();
  });

  it('should defer saves when in batch mode', () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    settings.autoConnect = false;
    MCPSettingsManager.saveSettings(settings);

    // Should not have written to disk yet
    expect(writeCount).toBe(0);
  });

  it('should save once when ending batch mode with pending changes', () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    MCPSettingsManager.saveSettings(settings);
    MCPSettingsManager.saveSettings(settings);
    MCPSettingsManager.saveSettings(settings);

    // Still no writes yet
    expect(writeCount).toBe(0);

    MCPSettingsManager.endBatch();

    // Should have written exactly once
    expect(writeCount).toBe(1);
  });

  it('should not save when ending batch mode without changes', () => {
    MCPSettingsManager.beginBatch();
    MCPSettingsManager.endBatch();

    expect(writeCount).toBe(0);
  });

  it('should update cache immediately even in batch mode', () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    settings.autoConnect = false;
    MCPSettingsManager.saveSettings(settings);

    // Cache should be updated immediately
    const cached = MCPSettingsManager.loadSettings();
    expect(cached.autoConnect).toBe(false);

    MCPSettingsManager.endBatch();
  });

  it('should save normally after batch mode ends', () => {
    MCPSettingsManager.beginBatch();
    MCPSettingsManager.endBatch();

    writeCount = 0; // Reset counter

    const settings = MCPSettingsManager.loadSettings();
    MCPSettingsManager.saveSettings(settings);

    expect(writeCount).toBe(1);
  });
});
