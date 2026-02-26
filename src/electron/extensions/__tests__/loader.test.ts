/**
 * Tests for Extension Loader - manifest validation and plugin compatibility
 */

import { describe, it, expect, vi, beforeEach as _beforeEach } from "vitest";

// Mock fs module
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Import after mocking
import { validateManifest, isPluginCompatible, generateManifestTemplate } from "../loader";
import type { PluginManifest } from "../types";

describe("validateManifest", () => {
  it("should validate a correct manifest", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(validateManifest(manifest)).toBe(true);
  });

  it("should reject null or undefined manifest", () => {
    expect(validateManifest(null)).toBe(false);
    expect(validateManifest(undefined)).toBe(false);
  });

  it("should throw error for missing name", () => {
    const manifest = {
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(() => validateManifest(manifest)).toThrow("missing required field: name");
  });

  it("should throw error for missing displayName", () => {
    const manifest = {
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(() => validateManifest(manifest)).toThrow("missing required field: displayName");
  });

  it("should throw error for missing version", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(() => validateManifest(manifest)).toThrow("missing required field: version");
  });

  it("should throw error for invalid version format", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "invalid",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(() => validateManifest(manifest)).toThrow("valid semver");
  });

  it("should accept valid semver versions", () => {
    const versions = ["1.0.0", "2.3.4", "0.0.1", "1.2.3-beta", "10.20.30"];

    for (const version of versions) {
      const manifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        version,
        description: "A test plugin",
        type: "channel",
        main: "dist/index.js",
      };

      expect(validateManifest(manifest)).toBe(true);
    }
  });

  it("should throw error for invalid type", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "invalid-type",
      main: "dist/index.js",
    };

    expect(() => validateManifest(manifest)).toThrow("invalid type");
  });

  it("should accept all valid types", () => {
    const types = ["channel", "tool", "provider", "integration"];

    for (const type of types) {
      const manifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        type,
        main: "dist/index.js",
      };

      expect(validateManifest(manifest)).toBe(true);
    }
  });

  it("should throw error for missing main entry point", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
    };

    expect(() => validateManifest(manifest)).toThrow("missing required field: main");
  });

  it("should validate config schema if present", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            description: "API key for the service",
          },
          enabled: {
            type: "boolean",
            description: "Enable the plugin",
            default: true,
          },
        },
      },
    };

    expect(validateManifest(manifest)).toBe(true);
  });

  it("should reject invalid config schema type", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      configSchema: {
        type: "array", // Invalid - must be 'object'
        properties: {},
      },
    };

    expect(() => validateManifest(manifest)).toThrow('type must be "object"');
  });

  it("should reject config schema with invalid property type", () => {
    const manifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      configSchema: {
        type: "object",
        properties: {
          invalid: {
            type: "invalid-type",
            description: "Invalid property",
          },
        },
      },
    };

    expect(() => validateManifest(manifest)).toThrow("invalid type");
  });
});

describe("isPluginCompatible", () => {
  it("should return true when no version constraint", () => {
    const manifest: PluginManifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
    };

    expect(isPluginCompatible(manifest, "0.3.0")).toBe(true);
    expect(isPluginCompatible(manifest, "1.0.0")).toBe(true);
    expect(isPluginCompatible(manifest, "2.0.0")).toBe(true);
  });

  it("should check major version compatibility", () => {
    const manifest: PluginManifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      coworkVersion: "1.0.0",
    };

    expect(isPluginCompatible(manifest, "1.0.0")).toBe(true);
    expect(isPluginCompatible(manifest, "1.5.0")).toBe(true);
    expect(isPluginCompatible(manifest, "2.0.0")).toBe(true);
    expect(isPluginCompatible(manifest, "0.9.0")).toBe(false);
  });

  it("should handle major version 0", () => {
    const manifest: PluginManifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      coworkVersion: "0.3.0",
    };

    expect(isPluginCompatible(manifest, "0.3.0")).toBe(true);
    expect(isPluginCompatible(manifest, "0.4.0")).toBe(true);
    expect(isPluginCompatible(manifest, "1.0.0")).toBe(true);
  });

  it("should enforce minimum version within major 0", () => {
    const manifest: PluginManifest = {
      name: "test-plugin",
      displayName: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "channel",
      main: "dist/index.js",
      coworkVersion: "0.4.0",
    };

    expect(isPluginCompatible(manifest, "0.3.28")).toBe(false);
    expect(isPluginCompatible(manifest, "0.4.0")).toBe(true);
    expect(isPluginCompatible(manifest, "0.5.0")).toBe(true);
  });
});

describe("generateManifestTemplate", () => {
  it("should generate a channel plugin template", () => {
    const manifest = generateManifestTemplate("My Plugin", "channel");

    expect(manifest.name).toBe("my-plugin");
    expect(manifest.displayName).toBe("My Plugin");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.type).toBe("channel");
    expect(manifest.main).toBe("dist/index.js");
    expect(manifest.capabilities).toBeDefined();
    expect(manifest.capabilities?.sendMessage).toBe(true);
    expect(manifest.capabilities?.receiveMessage).toBe(true);
  });

  it("should generate a tool plugin template", () => {
    const manifest = generateManifestTemplate("My Tool", "tool");

    expect(manifest.name).toBe("my-tool");
    expect(manifest.type).toBe("tool");
    expect(manifest.capabilities).toBeUndefined();
  });

  it("should sanitize plugin name", () => {
    const manifest = generateManifestTemplate("My Cool Plugin!!!", "channel");
    expect(manifest.name).toBe("my-cool-plugin---");
  });

  it("should include config schema with enabled property", () => {
    const manifest = generateManifestTemplate("Test", "channel");

    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema?.properties.enabled).toBeDefined();
    expect(manifest.configSchema?.properties.enabled.type).toBe("boolean");
    expect(manifest.configSchema?.properties.enabled.default).toBe(true);
  });

  it("should include keywords", () => {
    const manifest = generateManifestTemplate("Signal", "channel");

    expect(manifest.keywords).toContain("channel");
    expect(manifest.keywords).toContain("signal");
  });
});
