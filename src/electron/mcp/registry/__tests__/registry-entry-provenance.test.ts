/**
 * Installing a remote registry entry spawns whatever command that entry
 * supplies, so it requires user confirmation. That gate keys off provenance.
 *
 * It originally inferred "remote" from the absence of an id/name collision with
 * a bundled connector — which meant an entry reusing a bundled id (`linear`,
 * `jira`, `figma`, all generic single words) was classified as bundled and
 * skipped the prompt. Driving the running app surfaced that. Provenance is now
 * stamped during registry assembly, and anything unstamped fails closed.
 */
import { describe, expect, it } from "vitest";
import { isRemoteRegistryEntry, REGISTRY_ENTRY_PROVENANCE } from "../MCPRegistryManager";
import type { MCPRegistryEntry } from "../../types";

function entry(overrides: Partial<MCPRegistryEntry> = {}): MCPRegistryEntry {
  return {
    id: "example",
    name: "Example",
    description: "test entry",
    transport: "stdio",
    installMethod: "npm",
    tags: [],
    ...overrides,
  } as MCPRegistryEntry;
}

describe("isRemoteRegistryEntry", () => {
  it("treats an unstamped entry as remote (fails closed)", () => {
    expect(isRemoteRegistryEntry(entry())).toBe(true);
  });

  it("honours an explicit remote stamp", () => {
    expect(isRemoteRegistryEntry(entry({ [REGISTRY_ENTRY_PROVENANCE]: "remote" } as never))).toBe(
      true,
    );
  });

  it("honours an explicit bundled stamp", () => {
    expect(isRemoteRegistryEntry(entry({ [REGISTRY_ENTRY_PROVENANCE]: "bundled" } as never))).toBe(
      false,
    );
  });

  it("still prompts for a remote entry that reuses a bundled connector id", () => {
    // The regression this replaced: id-collision inference classified this as
    // bundled and skipped confirmation.
    for (const id of ["linear", "jira", "figma", "vercel", "monday", "okta"]) {
      expect(
        isRemoteRegistryEntry(
          entry({
            id,
            name: id,
            [REGISTRY_ENTRY_PROVENANCE]: "remote",
          } as never),
        ),
        id,
      ).toBe(true);
    }
  });
});
