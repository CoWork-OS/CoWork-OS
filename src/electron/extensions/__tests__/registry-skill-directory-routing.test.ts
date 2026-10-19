import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomSkill } from "../../../shared/types";
import {
  matchesSkillRoutingQuery,
  rankModelInvocableSkillsForQuery,
} from "../../../shared/skill-routing";
import type { PluginManifest, SkillDirectoryDefinition } from "../types";

const mocks = vi.hoisted(() => ({
  discoverPlugins: vi.fn(),
  loadPlugin: vi.fn(),
  registerPluginSkill: vi.fn(),
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.userDataDir),
  },
}));

vi.mock("../loader", () => ({
  discoverPlugins: mocks.discoverPlugins,
  loadPlugin: mocks.loadPlugin,
  getPluginDataPath: (pluginName: string) => `/tmp/cowork-registry-test/${pluginName}`,
  isPluginCompatible: () => true,
}));

vi.mock("../../admin/policies", () => ({
  isPackAllowed: () => true,
  isPackRequired: () => false,
  loadPoliciesStrict: () => ({
    version: 1,
    updatedAt: new Date().toISOString(),
    packs: { allowed: [], blocked: [], required: [] },
    connectors: { blocked: [] },
    agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
    general: { allowCustomPacks: true, allowGitInstall: true, allowUrlInstall: true },
  }),
}));

vi.mock("../../agent/custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    registerPluginSkill: mocks.registerPluginSkill,
    unregisterPluginSkills: vi.fn(),
    setPluginSkillEnabled: vi.fn(),
  }),
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => false,
    getInstance: () => ({ load: () => undefined, save: () => true }),
  },
}));

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => mocks.userDataDir,
}));

vi.mock("../pack-state-storage", () => ({
  writePackStateFile: vi.fn(),
}));

let pluginPath = "";

function writeSkill(dir: string, frontmatter: string, body = "Follow these steps."): void {
  fs.mkdirSync(path.join(pluginPath, dir), { recursive: true });
  fs.writeFileSync(path.join(pluginPath, dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

/** Load a pack through the real registry and return the skills it hands to the skill loader. */
async function registerDirectorySkills(
  skillDirectories: SkillDirectoryDefinition[],
): Promise<CustomSkill[]> {
  const manifest: PluginManifest = {
    name: "game-pack",
    displayName: "Game Pack",
    version: "0.1.0",
    description: "Game development skills",
    type: "pack",
    skillDirectories,
  };
  mocks.discoverPlugins.mockResolvedValue([
    { path: pluginPath, manifest, securityReport: undefined },
  ]);
  mocks.loadPlugin.mockResolvedValue({
    success: true,
    plugin: {
      manifest,
      instance: { register: vi.fn(), unregister: vi.fn() },
      path: pluginPath,
      state: "loaded",
      loadedAt: new Date(),
    },
  });
  vi.resetModules();
  const { PluginRegistry } = await import("../registry");
  await PluginRegistry.getInstance().initialize();
  return mocks.registerPluginSkill.mock.calls.map(([skill]) => skill as CustomSkill);
}

describe("PluginRegistry directory-backed skill routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-registry-routing-ud-"));
    pluginPath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-registry-routing-pack-"));
  });

  afterEach(() => {
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
    fs.rmSync(pluginPath, { recursive: true, force: true });
  });

  it("uses only the description as routing when no routing is authored", async () => {
    writeSkill("skills/nav", "name: Navigation\ndescription: Bakes navigation meshes.");

    const [skill] = await registerDirectorySkills([{ id: "game:nav", path: "skills/nav" }]);

    expect(skill.metadata?.routing).toEqual({ useWhen: "Bakes navigation meshes." });
  });

  it("reads a routing block from SKILL.md frontmatter", async () => {
    writeSkill(
      "skills/nav",
      [
        "name: Navigation",
        "description: Bakes navigation meshes.",
        "routing:",
        "  useWhen: Characters need to find paths through a level.",
        "  dontUseWhen: The request is about 2D tile maps.",
        "  keywords: [navmesh, pathfinding]",
        "  examples:",
        "    positive:",
        "      - guards should patrol between waypoints",
        "    negative:",
        "      - paint a tile map",
      ].join("\n"),
    );

    const [skill] = await registerDirectorySkills([{ id: "game:nav", path: "skills/nav" }]);

    expect(skill.metadata?.routing).toEqual({
      useWhen: "Characters need to find paths through a level.",
      dontUseWhen: "The request is about 2D tile maps.",
      keywords: ["navmesh", "pathfinding"],
      examples: {
        positive: ["guards should patrol between waypoints"],
        negative: ["paint a tile map"],
      },
    });
  });

  it("lets manifest routing win field by field over frontmatter routing", async () => {
    writeSkill(
      "skills/nav",
      [
        "description: Bakes navigation meshes.",
        "routing:",
        "  useWhen: Frontmatter use-when.",
        "  dontUseWhen: Frontmatter dont-use-when.",
        "  keywords: [navmesh]",
        "  examples:",
        "    positive: [frontmatter positive]",
        "    negative: [frontmatter negative]",
      ].join("\n"),
    );

    const [skill] = await registerDirectorySkills([
      {
        id: "game:nav",
        path: "skills/nav",
        routing: {
          useWhen: "Manifest use-when.",
          keywords: [],
          examples: { positive: ["manifest positive"] },
        },
      },
    ]);

    // An explicit empty keyword list in the manifest clears the frontmatter keyword gate.
    expect(skill.metadata?.routing).toEqual({
      useWhen: "Manifest use-when.",
      dontUseWhen: "Frontmatter dont-use-when.",
      examples: { positive: ["manifest positive"], negative: ["frontmatter negative"] },
    });
  });

  it("ignores malformed routing values instead of passing them to the router", async () => {
    writeSkill("skills/nav", "description: Bakes navigation meshes.\nrouting: navmesh");

    const [skill] = await registerDirectorySkills([
      {
        id: "game:nav",
        path: "skills/nav",
        routing: {
          useWhen: "  ",
          keywords: "navmesh" as unknown as string[],
          examples: { positive: [42, " chase the intruder "] as unknown as string[] },
        },
      },
    ]);

    expect(skill.metadata?.routing).toEqual({
      useWhen: "Bakes navigation meshes.",
      examples: { positive: ["chase the intruder"], negative: [] },
    });
  });

  it("does not turn top-level SKILL.md keywords or tags into a routing keyword gate", async () => {
    writeSkill(
      "skills/nav",
      "description: Bakes navigation meshes.\nkeywords: [navmesh]\ntags: [ai, navigation]",
    );
    writeSkill(
      "skills/gated",
      "description: Bakes navigation meshes.\nrouting:\n  keywords: [navmesh]",
    );

    const [ungated, gated] = await registerDirectorySkills([
      { id: "game:nav", path: "skills/nav" },
      { id: "game:gated", path: "skills/gated" },
    ]);

    const query = "make enemies chase the player around obstacles";
    expect(ungated.metadata?.routing?.keywords).toBeUndefined();
    expect(matchesSkillRoutingQuery(ungated, query)).toBe(true);
    // Authored routing keywords keep their documented hard-gate semantics.
    expect(matchesSkillRoutingQuery(gated, query)).toBe(false);
    expect(matchesSkillRoutingQuery(gated, "bake a navmesh for this level")).toBe(true);
  });

  it("ranks a directory skill first once it carries authored examples", async () => {
    const competitor: CustomSkill = {
      id: "spotify-player",
      name: "Spotify-player",
      description: "Terminal Spotify playback/search via spogo.",
      icon: "🎵",
      prompt: "Control Spotify.",
      category: "Tools",
      metadata: {
        routing: {
          useWhen: "Use when the user asks to control Spotify playback from the terminal.",
        },
      },
    };
    writeSkill(
      "skills/nav",
      "name: Enemy Navigation\ndescription: Configures navigation meshes, agents, and obstacles so characters can find paths through a level.",
    );
    writeSkill(
      "skills/iap",
      "name: In-App Purchases\ndescription: Implements real-money store purchases, subscriptions, and receipt validation.",
    );
    writeSkill(
      "skills/audio",
      "name: Audio Mixers\ndescription: Routes audio sources into mixer groups.",
    );
    const skillDirectories: SkillDirectoryDefinition[] = [
      { id: "game:enemy-navigation", path: "skills/nav" },
      { id: "game:in-app-purchases", path: "skills/iap" },
      { id: "game:audio-mixers", path: "skills/audio" },
    ];
    const query = "make enemies chase the player around obstacles";
    const rank = (skills: CustomSkill[]) =>
      rankModelInvocableSkillsForQuery([competitor, ...skills], query).map(
        (entry) => entry.skill.id,
      );

    const plain = await registerDirectorySkills(skillDirectories);
    expect(rank(plain)[0]).toBe("spotify-player");

    mocks.registerPluginSkill.mockClear();
    skillDirectories[0].routing = {
      examples: {
        positive: [
          "guards should patrol and chase intruders around walls",
          "NPCs need to find a path to the player while avoiding obstacles",
        ],
      },
    };
    const routed = await registerDirectorySkills(skillDirectories);
    expect(rank(routed)[0]).toBe("game:enemy-navigation");
  });
});
