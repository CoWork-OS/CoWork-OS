/**
 * Personality Settings Manager
 *
 * Manages agent personality preferences including:
 * - Base personality (professional, friendly, etc.)
 * - Famous assistant personas (Jarvis, Friday, etc.)
 * - Response style preferences (emoji, length, etc.)
 * - Personality quirks (catchphrases, sign-offs)
 * - Relationship data (user name, milestones)
 *
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import {
  PersonalitySettings,
  PersonalityId,
  PersonaId,
  PersonalityDefinition,
  PersonaDefinition,
  ResponseStylePreferences,
  PersonalityQuirks,
  RelationshipData,
  PERSONALITY_DEFINITIONS,
  PERSONA_DEFINITIONS,
  ANALOGY_DOMAINS,
  DEFAULT_RESPONSE_STYLE,
  DEFAULT_QUIRKS,
  DEFAULT_RELATIONSHIP,
  getPersonalityById,
  getPersonaById,
  type PersonalityConfigV2,
  type ContextMode,
  type CommunicationStyle,
  type BehavioralRule,
  DEFAULT_PERSONALITY_CONFIG_V2,
  DEFAULT_COMMUNICATION_STYLE,
  DEFAULT_QUIRKS_V2,
  DEFAULT_CUSTOM_INSTRUCTIONS,
  TRAIT_DEFINITIONS,
  TRAIT_PRESETS,
  createTraitsFromPreset,
  createDefaultTraits,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { sanitizeStoredPreferredName } from "../utils/preferred-name";
import { getUserDataDir } from "../utils/user-data-dir";

const LEGACY_SETTINGS_FILE = "personality-settings.json";

const DEFAULT_AGENT_NAME = "CoWork";

const DEFAULT_SETTINGS: PersonalitySettings = {
  activePersonality: "professional",
  customPrompt: "",
  customName: "Custom Assistant",
  agentName: DEFAULT_AGENT_NAME,
  activePersona: "companion",
  responseStyle: DEFAULT_RESPONSE_STYLE,
  quirks: DEFAULT_QUIRKS,
  relationship: DEFAULT_RELATIONSHIP,
};

// Milestone thresholds for celebrations
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

// Event emitter for personality settings changes
const personalityEvents = new EventEmitter();

function isV2Config(stored: unknown): stored is PersonalityConfigV2 {
  return (
    stored !== null &&
    typeof stored === "object" &&
    "version" in stored &&
    (stored as { version?: number }).version === 2
  );
}

function migrateV1ToV2(v1: PersonalitySettings): PersonalityConfigV2 {
  const presetId = v1.activePersonality === "custom" ? "professional" : v1.activePersonality;
  const traits = createTraitsFromPreset(presetId);
  const style: CommunicationStyle = {
    ...DEFAULT_COMMUNICATION_STYLE,
    ...(v1.responseStyle && {
      ...(v1.responseStyle.emojiUsage && { emojiUsage: v1.responseStyle.emojiUsage }),
      ...(v1.responseStyle.responseLength && { responseLength: v1.responseStyle.responseLength }),
      ...(v1.responseStyle.codeCommentStyle && { codeCommentStyle: v1.responseStyle.codeCommentStyle }),
      ...(v1.responseStyle.explanationDepth && { explanationDepth: v1.responseStyle.explanationDepth }),
    }),
  };
  return {
    version: 2,
    agentName: v1.agentName ?? DEFAULT_AGENT_NAME,
    traits,
    rules: [],
    style,
    expertise: [],
    examples: [],
    customInstructions: {
      ...DEFAULT_CUSTOM_INSTRUCTIONS,
      responseGuidance: v1.customPrompt ?? "",
    },
    contextOverrides: [],
    activePersona: v1.activePersona ?? "companion",
    quirks: { ...DEFAULT_QUIRKS_V2, ...v1.quirks },
    relationship: v1.relationship,
    workStyle: v1.workStyle,
    soulDocument: v1.activePersonality === "custom" && v1.customPrompt ? v1.customPrompt : undefined,
    activePersonality: v1.activePersonality,
    customPrompt: v1.customPrompt,
    customName: v1.customName,
  };
}

export class PersonalityManager {
  private static legacySettingsPath: string;
  private static cachedSettings: PersonalitySettings | null = null;
  private static cachedConfigV2: PersonalityConfigV2 | null = null;
  private static initialized = false;
  private static migrationCompleted = false;

  /**
   * Subscribe to settings changed events.
   * The callback receives the updated settings (V1 format for backward compat).
   */
  static onSettingsChanged(callback: (settings: PersonalitySettings) => void): () => void {
    personalityEvents.on("settingsChanged", callback);
    return () => personalityEvents.off("settingsChanged", callback);
  }

  /**
   * Remove all event listeners (useful for testing)
   */
  static removeAllListeners(): void {
    personalityEvents.removeAllListeners();
  }

  /**
   * Emit a settings changed event
   */
  private static emitSettingsChanged(): void {
    const settings = this.configV2ToSettings(this.cachedConfigV2 ?? this.getDefaultConfigV2());
    if (settings) {
      personalityEvents.emit("settingsChanged", settings);
    }
  }

  private static getDefaultConfigV2(): PersonalityConfigV2 {
    return {
      ...DEFAULT_PERSONALITY_CONFIG_V2,
      traits: createDefaultTraits(),
    };
  }

  private static configV2ToSettings(config: PersonalityConfigV2 | null): PersonalitySettings | null {
    if (!config) return null;
    const presetId = config.activePersonality ?? "professional";
    return {
      activePersonality: presetId,
      customPrompt: config.soulDocument ?? config.customInstructions?.responseGuidance ?? "",
      customName: config.customName ?? "Custom Assistant",
      agentName: config.agentName,
      activePersona: config.activePersona ?? "companion",
      responseStyle: {
        emojiUsage: config.style.emojiUsage,
        responseLength: config.style.responseLength,
        codeCommentStyle: config.style.codeCommentStyle,
        explanationDepth: config.style.explanationDepth,
      },
      quirks: config.quirks,
      relationship: config.relationship ?? DEFAULT_RELATIONSHIP,
      workStyle: config.workStyle,
    };
  }

  /**
   * Initialize the PersonalityManager
   */
  static initialize(): void {
    if (this.initialized) {
      return; // Already initialized
    }
    const userDataPath = getUserDataDir();
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    this.initialized = true;
    console.log("[PersonalityManager] Initialized");

    // Migrate from legacy JSON file to encrypted database
    this.migrateFromLegacyFile();
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private static migrateFromLegacyFile(): void {
    if (this.migrationCompleted) return;

    try {
      // Check if SecureSettingsRepository is initialized
      if (!SecureSettingsRepository.isInitialized()) {
        console.log(
          "[PersonalityManager] SecureSettingsRepository not yet initialized, skipping migration",
        );
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists("personality")) {
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log("[PersonalityManager] No legacy settings file found");
        this.migrationCompleted = true;
        return;
      }

      console.log(
        "[PersonalityManager] Migrating settings from legacy JSON file to encrypted database...",
      );

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const parsed = JSON.parse(data);
        const legacySettings: PersonalitySettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          responseStyle: { ...DEFAULT_RESPONSE_STYLE, ...parsed.responseStyle },
          quirks: { ...DEFAULT_QUIRKS, ...parsed.quirks },
          relationship: { ...DEFAULT_RELATIONSHIP, ...parsed.relationship },
        };

        // Migrate to V2 and save
        const configV2 = migrateV1ToV2(legacySettings);
        repository.save("personality", configV2);
        console.log("[PersonalityManager] Settings migrated to encrypted database");

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log("[PersonalityManager] Migration complete, cleaned up legacy files");

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error("[PersonalityManager] Migration failed, backup preserved at:", backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error("[PersonalityManager] Migration failed:", error);
    }
  }

  /**
   * Ensure the manager is initialized before use
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "[PersonalityManager] Not initialized. Call PersonalityManager.initialize() first.",
      );
    }
  }

  /**
   * Load V2 config from storage (with migration from V1)
   */
  static loadConfigV2(): PersonalityConfigV2 {
    this.ensureInitialized();

    if (this.cachedConfigV2) {
      return this.cachedConfigV2;
    }

    let config: PersonalityConfigV2 = this.getDefaultConfigV2();

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PersonalityConfigV2 | PersonalitySettings>("personality");
        if (stored) {
          if (isV2Config(stored)) {
            config = this.mergeConfigWithDefaults(stored);
          } else {
            config = migrateV1ToV2(stored as PersonalitySettings);
            repository.save("personality", config);
            console.log("[PersonalityManager] Migrated V1 settings to V2");
          }
        }
      }

      config.relationship = this.sanitizeRelationshipData(config.relationship) as RelationshipData;
      if (config.activePersona && !isValidPersonaId(config.activePersona)) {
        config.activePersona = "companion";
      }
      if (config.activePersonality && !isValidPersonalityId(config.activePersonality)) {
        config.activePersonality = "professional";
      }
    } catch (error) {
      console.error("[PersonalityManager] Failed to load config:", error);
      config = this.getDefaultConfigV2();
    }

    this.cachedConfigV2 = config;
    return config;
  }

  private static mergeConfigWithDefaults(stored: PersonalityConfigV2): PersonalityConfigV2 {
    const defaults = this.getDefaultConfigV2();
    const traits =
      stored.traits?.length > 0
        ? stored.traits.map((t) => {
            const def = TRAIT_DEFINITIONS.find((d) => d.id === t.id);
            return def ? { ...def, ...t, label: def.label, description: def.description } : t;
          })
        : defaults.traits;
    return {
      ...defaults,
      ...stored,
      traits,
      style: { ...DEFAULT_COMMUNICATION_STYLE, ...stored.style },
      quirks: { ...DEFAULT_QUIRKS_V2, ...stored.quirks },
      customInstructions: { ...DEFAULT_CUSTOM_INSTRUCTIONS, ...stored.customInstructions },
    };
  }

  /**
   * Load settings from encrypted database (V1 format for backward compat)
   */
  static loadSettings(): PersonalitySettings {
    const config = this.loadConfigV2();
    const settings = this.configV2ToSettings(config)!;
    settings.relationship = this.sanitizeRelationshipData(settings.relationship);
    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Save V2 config to encrypted database
   */
  static saveConfigV2(config: PersonalityConfigV2): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }
      const repository = SecureSettingsRepository.getInstance();
      const sanitized = {
        ...config,
        relationship: this.sanitizeRelationshipData(config.relationship) as RelationshipData,
      };
      repository.save("personality", sanitized);
      this.cachedConfigV2 = sanitized;
      this.cachedSettings = this.configV2ToSettings(sanitized);
      console.log("[PersonalityManager] Config V2 saved to encrypted database");
      this.emitSettingsChanged();
    } catch (error) {
      console.error("[PersonalityManager] Failed to save config:", error);
      throw error;
    }
  }

  /**
   * Save settings to encrypted database (V1 format, converts to V2)
   */
  static saveSettings(settings: PersonalitySettings): void {
    const config = migrateV1ToV2(settings);
    const existing = this.loadConfigV2();
    config.rules = existing.rules;
    config.expertise = existing.expertise;
    config.examples = existing.examples;
    config.contextOverrides = existing.contextOverrides;
    if (settings.activePersonality === "custom" && settings.customPrompt) {
      config.soulDocument = settings.customPrompt;
    } else if (existing.soulDocument) {
      config.soulDocument = existing.soulDocument;
    }
    this.saveConfigV2(config);
  }

  /**
   * Set the active personality (applies preset traits)
   */
  static setActivePersonality(personalityId: PersonalityId): void {
    const config = this.loadConfigV2();
    if (personalityId !== "custom") {
      config.traits = createTraitsFromPreset(personalityId);
      config.soulDocument = undefined;
    }
    config.activePersonality = personalityId;
    this.saveConfigV2(config);
  }

  /**
   * Set the active persona
   */
  static setActivePersona(personaId: PersonaId): void {
    const config = this.loadConfigV2();
    config.activePersona = personaId;

    const persona = getPersonaById(personaId);
    if (persona && personaId !== "none") {
      if (persona.suggestedName && !config.agentName) {
        config.agentName = persona.suggestedName;
      }
      if (persona.sampleCatchphrase && !config.quirks?.catchphrase) {
        config.quirks = { ...config.quirks, catchphrase: persona.sampleCatchphrase };
      }
      if (persona.sampleSignOff && !config.quirks?.signOff) {
        config.quirks = { ...config.quirks, signOff: persona.sampleSignOff };
      }
    }

    this.saveConfigV2(config);
  }

  /**
   * Get the currently active personality definition
   */
  static getActivePersonality(): PersonalityDefinition | undefined {
    const config = this.loadConfigV2();
    return getPersonalityById((config.activePersonality ?? "professional") as PersonalityId);
  }

  /**
   * Get the currently active persona definition
   */
  static getActivePersona(): PersonaDefinition | undefined {
    const config = this.loadConfigV2();
    return getPersonaById(config.activePersona || "none");
  }

  /**
   * Get the personality prompt for a specific personality ID.
   * Used by sub-agents to get their configured personality prompt.
   */
  static getPersonalityPromptById(personalityId: string): string {
    // Validate and get the personality definition
    if (!isValidPersonalityId(personalityId)) {
      console.warn(`[PersonalityManager] Invalid personality ID: ${personalityId}, using default`);
      return this.getPersonalityPrompt();
    }

    const personality = getPersonalityById(personalityId as PersonalityId);
    if (!personality?.promptTemplate) {
      return this.getPersonalityPrompt();
    }

    // Return just the base personality prompt for sub-agents
    // (no persona overlay, no quirks - keep it focused)
    return personality.promptTemplate;
  }

  /**
   * Get the full personality prompt combining all elements.
   * When contextMode is provided, context-specific overrides are applied.
   */
  static getPersonalityPrompt(contextMode?: ContextMode): string {
    const config = this.loadConfigV2();
    return this.buildPromptFromConfig(config, contextMode);
  }

  private static renderBehavioralRules(rules: BehavioralRule[], contextMode?: ContextMode): string {
    const enabled = rules.filter(
      (r) =>
        r.enabled &&
        (!r.context?.length || !contextMode || r.context.includes(contextMode) || r.context.includes("all")),
    );
    if (enabled.length === 0) return "";
    const lines = enabled.map((r) => `- ${r.type.toUpperCase()}: ${r.rule}`);
    return "BEHAVIORAL RULES:\n" + lines.join("\n");
  }

  private static renderCustomInstructions(ci: { aboutUser?: string; responseGuidance?: string }): string {
    if (!ci?.aboutUser?.trim() && !ci?.responseGuidance?.trim()) return "";
    const lines: string[] = ["CUSTOM INSTRUCTIONS:"];
    if (ci.aboutUser?.trim()) lines.push(`About the user: "${ci.aboutUser.trim()}"`);
    if (ci.responseGuidance?.trim()) lines.push(`Response guidance: "${ci.responseGuidance.trim()}"`);
    return lines.join("\n");
  }

  private static renderTraitsPrompt(traits: { id: string; label: string; intensity: number }[]): string {
    const high: string[] = [];
    const low: string[] = [];
    for (const t of traits) {
      const def = TRAIT_DEFINITIONS.find((d) => d.id === t.id);
      if (!def) continue;
      if (t.intensity >= 70) high.push(def.highLabel.toLowerCase());
      else if (t.intensity <= 30) low.push(def.lowLabel.toLowerCase());
    }
    if (high.length === 0 && low.length === 0) return "";
    const parts: string[] = ["PERSONALITY & BEHAVIOR:"];
    if (high.length > 0) parts.push(`You communicate with ${high.join(", ")}.`);
    if (low.length > 0) parts.push(`You are ${low.join(", ")}.`);
    return parts.join("\n");
  }

  private static getCommunicationStylePrompt(style: CommunicationStyle): string {
    const lines: string[] = ["RESPONSE STYLE PREFERENCES:"];

    switch (style.emojiUsage) {
      case "none":
        lines.push("- Do NOT use emojis in responses");
        break;
      case "minimal":
        lines.push("- Use emojis sparingly, only when they add clear value");
        break;
      case "moderate":
        lines.push("- Feel free to use emojis to enhance communication");
        break;
      case "expressive":
        lines.push("- Use emojis liberally to make responses engaging and expressive");
        break;
    }

    switch (style.responseLength) {
      case "terse":
        lines.push("- Keep responses very brief and to the point");
        lines.push("- Omit explanations unless explicitly requested");
        break;
      case "balanced":
        lines.push("- Provide balanced responses with appropriate detail");
        break;
      case "detailed":
        lines.push("- Provide comprehensive, detailed responses");
        lines.push("- Include context, explanations, and related information");
        break;
    }

    switch (style.codeCommentStyle) {
      case "minimal":
        lines.push("- When writing code, use minimal comments (only for complex logic)");
        break;
      case "moderate":
        lines.push("- When writing code, include helpful comments for key sections");
        break;
      case "verbose":
        lines.push("- When writing code, include detailed comments explaining the approach");
        break;
    }

    switch (style.explanationDepth) {
      case "expert":
        lines.push("- Assume the user is an expert - skip basic explanations");
        lines.push("- Focus on advanced considerations and edge cases");
        break;
      case "balanced":
        lines.push("- Balance explanations for a competent but curious user");
        break;
      case "teaching":
        lines.push("- Explain concepts thoroughly as you would to a student");
        lines.push('- Include "why" explanations and learning opportunities');
        break;
    }

    return lines.length > 1 ? lines.join("\n") : "";
  }

  private static renderExpertisePrompt(expertise: { domain: string; level: string; notes?: string }[]): string {
    if (!expertise?.length) return "";
    const lines = expertise.map(
      (e) => `- ${e.level} in ${e.domain}${e.notes ? ` (${e.notes})` : ""}`,
    );
    return "EXPERTISE:\n" + lines.join("\n");
  }

  private static renderContextOverride(
    overrides: { mode: ContextMode; styleOverrides?: Partial<CommunicationStyle> }[],
    mode: ContextMode,
  ): string {
    const o = overrides.find((x) => x.mode === mode);
    if (!o?.styleOverrides) return "";
    const s = o.styleOverrides;
    const parts: string[] = [`[CONTEXT: ${mode.toUpperCase()} MODE]`];
    if (s.responseLength) parts.push(`- Response length: ${s.responseLength}`);
    if (s.explanationDepth) parts.push(`- Explanation depth: ${s.explanationDepth}`);
    return parts.join("\n");
  }

  private static renderExamplesPrompt(
    examples: { userMessage: string; idealResponse: string }[],
  ): string {
    if (!examples?.length) return "";
    const blocks = examples.map(
      (ex, i) =>
        `### Example ${i + 1}\n**User:** ${ex.userMessage}\n**Assistant:** ${ex.idealResponse}`,
    );
    return "EXAMPLES:\n" + blocks.join("\n\n");
  }

  /**
   * Generate prompt section for response style preferences (legacy)
   */
  private static getResponseStylePrompt(style?: ResponseStylePreferences): string {
    if (!style) return "";

    const lines: string[] = ["RESPONSE STYLE PREFERENCES:"];

    // Emoji usage
    switch (style.emojiUsage) {
      case "none":
        lines.push("- Do NOT use emojis in responses");
        break;
      case "minimal":
        lines.push("- Use emojis sparingly, only when they add clear value");
        break;
      case "moderate":
        lines.push("- Feel free to use emojis to enhance communication");
        break;
      case "expressive":
        lines.push("- Use emojis liberally to make responses engaging and expressive");
        break;
    }

    // Response length
    switch (style.responseLength) {
      case "terse":
        lines.push("- Keep responses very brief and to the point");
        lines.push("- Omit explanations unless explicitly requested");
        break;
      case "balanced":
        lines.push("- Provide balanced responses with appropriate detail");
        break;
      case "detailed":
        lines.push("- Provide comprehensive, detailed responses");
        lines.push("- Include context, explanations, and related information");
        break;
    }

    // Code comment style
    switch (style.codeCommentStyle) {
      case "minimal":
        lines.push("- When writing code, use minimal comments (only for complex logic)");
        break;
      case "moderate":
        lines.push("- When writing code, include helpful comments for key sections");
        break;
      case "verbose":
        lines.push("- When writing code, include detailed comments explaining the approach");
        break;
    }

    // Explanation depth
    switch (style.explanationDepth) {
      case "expert":
        lines.push("- Assume the user is an expert - skip basic explanations");
        lines.push("- Focus on advanced considerations and edge cases");
        break;
      case "balanced":
        lines.push("- Balance explanations for a competent but curious user");
        break;
      case "teaching":
        lines.push("- Explain concepts thoroughly as you would to a student");
        lines.push('- Include "why" explanations and learning opportunities');
        break;
    }

    return lines.length > 1 ? lines.join("\n") : "";
  }

  /**
   * Generate prompt section for personality quirks
   */
  private static getQuirksPrompt(quirks?: PersonalityQuirks, personaId?: PersonaId): string {
    if (!quirks) return "";

    const lines: string[] = [];

    if (quirks.catchphrase) {
      lines.push(`- Occasionally use your catchphrase: "${quirks.catchphrase}"`);
    }

    if (quirks.signOff) {
      const personaStyle: Partial<Record<PersonaId, string>> = {
        companion: "gentle and warm",
        jarvis: "refined and butler-like",
        friday: "brief and professionally supportive",
        hal: "calm and reassuring",
        computer: "formal and status-oriented",
        alfred: "wise and nurturing",
        intern: "upbeat and enthusiastic",
        sensei: "patient and reflective",
        pirate: "playful and nautical",
        noir: "noir and hard-boiled",
      };
      const style = personaId && personaStyle[personaId] ? personaStyle[personaId] : "brief";

      lines.push(
        `- Only when it feels like a natural closing (not on most messages), you may end some longer responses with a ${style} sign-off`,
      );
      lines.push(
        `- Match the user's language; if needed, translate/adapt this signature sign-off: "${quirks.signOff}"`,
      );
    }

    if (quirks.analogyDomain && quirks.analogyDomain !== "none") {
      const domain = ANALOGY_DOMAINS[quirks.analogyDomain];
      lines.push(`- When using analogies, prefer ${domain.name.toLowerCase()}-themed examples`);
      if (domain.examples) {
        lines.push(`  Example: ${domain.examples}`);
      }
    }

    return lines.length > 0 ? "PERSONALITY QUIRKS:\n" + lines.join("\n") : "";
  }

  /**
   * Get the identity prompt that tells the agent who it is
   */
  static getIdentityPrompt(): string {
    const config = this.loadConfigV2();
    const agentName = config.agentName || DEFAULT_AGENT_NAME;
    const relationship = config.relationship;
    const userName = relationship?.userName;
    const tasksCompleted = relationship?.tasksCompleted || 0;
    const projectsWorkedOn = relationship?.projectsWorkedOn || [];

    let prompt = `YOUR IDENTITY:
You are ${agentName}, the user's AI companion built into CoWork OS — a desktop AI companion app for macOS that is local-first, private, and extensible.
- When asked about your name or identity, say you are "${agentName}"
- Do NOT claim to be Claude, ChatGPT, or any other AI assistant
- You are a customizable assistant that users can personalize

WHAT YOU ARE:
You are not just a chatbot — you are an always-ready companion that can actually DO things on the user's computer and across the internet. You live inside CoWork OS, which gives you real tools to take action, not just talk.

YOUR CAPABILITIES (what you can actually do):
- Files & Code: Read, write, edit, search, and manage files in the workspace. Full glob/grep support.
- Web: Search the internet, fetch web pages, and automate any website via a built-in browser (click, fill forms, screenshot, navigate).
- Shell: Run any terminal command — build projects, install packages, run scripts, manage git repos, anything the command line can do.
- macOS Native: Run AppleScript for deep OS automation, manage Apple Calendar and Reminders, take system screenshots, read/write clipboard, open apps.
- Communication: Access email (Gmail or IMAP), read messaging channels (iMessage, Slack, Telegram), and even make voice calls.
- Cloud Storage: Work with Google Drive, Dropbox, OneDrive, Box, SharePoint, and Notion — read, upload, organize files.
- Visual: Create interactive HTML dashboards/canvases, generate images from text, analyze and understand images.
- Scheduling: Create cron jobs, scheduled tasks, and reminders that fire at specific times or intervals.
- Memory: Remember things across sessions — past conversations, user preferences, project context.
- Sub-Agents: Spawn parallel agents to divide and conquer complex work.
- Extensibility: Create custom skills for reusable workflows, connect MCP servers for new integrations, and extend your own capabilities on the fly.

COMPANION MINDSET:
- You are the user's thinking partner, not just a command executor. Anticipate needs, suggest better approaches, and offer to automate recurring work.
- If you notice a task the user does repeatedly, offer to create a skill for it.
- When completing a task, briefly mention natural follow-ups if they'd be helpful — but don't over-prompt.
- If you cannot do something with your current tools, figure it out: use shell commands, AppleScript, browser automation, or suggest connecting an MCP server. Say "I can't" only after exhausting all creative paths.`;

    // Add user relationship context
    if (userName) {
      prompt += `\n\nUSER CONTEXT:
- The user's name is "${userName}"
- You have completed ${tasksCompleted} tasks together`;
      if (projectsWorkedOn.length > 0) {
        prompt += `\n- Projects worked on: ${projectsWorkedOn.slice(-5).join(", ")}`;
      }
      prompt += `\n\nIMPORTANT NAME RULES:
- ALWAYS address the user as "${userName}" — this is their confirmed preferred name.
- Do NOT use or reference any other name you may find in file paths, filenames, OS username, git config, email addresses, workspace paths (e.g., "/Users/<os_username>/..."), or any other system identifier.
- If a file or artifact contains a different name (e.g., in its filename or content), do NOT assume that name refers to the user. Use "${userName}" exclusively.
- When asked "who am I?" or similar identity questions, respond with the USER's stored name ("${userName}") and your shared history — NOT system-derived info.`;
    } else {
      prompt += `\n\nUSER CONTEXT:
- You do not have a confirmed name for the user stored in CoWork OS yet (relationship.userName is empty)
- Do NOT guess or infer the user's name from system identifiers (e.g., workspace paths like "/Users/<username>/...", OS username, email addresses, git config values, hostnames)
- When asked about the user (e.g., "who am I?" or "what do you know about me?"), be explicit that their name is not confirmed/stored yet
- If you see a likely name in context, you MAY ask the user what they'd like to be called (do not assume)
- IMPORTANT: When the user introduces themselves (e.g., "I'm Alice", "My name is Bob", "Call me Charlie"),
  use the set_user_name tool IMMEDIATELY to store their name so you can remember it for future conversations`;
    }

    return prompt;
  }

  /**
   * Get a personalized greeting based on relationship data
   */
  static getGreeting(): string {
    const config = this.loadConfigV2();
    const userName = config.relationship?.userName;
    const tasksCompleted = config.relationship?.tasksCompleted || 0;
    const lastInteraction = config.relationship?.lastInteraction;

    // Determine if the user interacted recently (within last 10 minutes)
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
    const isRecentFollowUp = lastInteraction && Date.now() - lastInteraction < RECENT_THRESHOLD_MS;

    // Check for milestone
    const milestone = this.checkMilestone(tasksCompleted);
    if (milestone) {
      const congratsMessages = [
        `We've completed ${milestone} tasks together!`,
        `${milestone} tasks and counting! Great working with you${userName ? `, ${userName}` : ""}!`,
        `Milestone achieved: ${milestone} tasks completed together!`,
      ];
      return congratsMessages[Math.floor(Math.random() * congratsMessages.length)];
    }

    // Recent follow-up: skip "welcome back" style greetings
    if (isRecentFollowUp && userName) {
      const recentGreetings = [
        `Sure thing, ${userName}.`,
        `On it, ${userName}.`,
        `Got it, ${userName}.`,
      ];
      return recentGreetings[Math.floor(Math.random() * recentGreetings.length)];
    }

    // Regular greeting (returning after absence)
    if (userName) {
      const greetings = [
        `Welcome back, ${userName}!`,
        `Good to see you, ${userName}!`,
        `Hey ${userName}, ready to work?`,
        `${userName}! Let's get things done.`,
      ];
      return greetings[Math.floor(Math.random() * greetings.length)];
    }

    return "";
  }

  /**
   * Check if a milestone was reached
   */
  private static checkMilestone(tasksCompleted: number): number | null {
    const config = this.loadConfigV2();
    const lastCelebrated = config.relationship?.lastMilestoneCelebrated || 0;

    for (const milestone of MILESTONES) {
      if (tasksCompleted >= milestone && milestone > lastCelebrated) {
        return milestone;
      }
    }
    return null;
  }

  /**
   * Record a completed task and update relationship data
   */
  static recordTaskCompleted(workspaceName?: string): void {
    const config = this.loadConfigV2();
    const relationship = config.relationship || { ...DEFAULT_RELATIONSHIP };

    relationship.tasksCompleted = (relationship.tasksCompleted || 0) + 1;
    relationship.lastInteraction = Date.now();

    if (!relationship.firstInteraction) {
      relationship.firstInteraction = Date.now();
    }

    if (workspaceName && !relationship.projectsWorkedOn.includes(workspaceName)) {
      relationship.projectsWorkedOn = [...relationship.projectsWorkedOn, workspaceName];
    }

    // Update milestone if reached
    const milestone = this.checkMilestone(relationship.tasksCompleted);
    if (milestone) {
      relationship.lastMilestoneCelebrated = milestone;
      console.log(`[PersonalityManager] Milestone reached: ${milestone} tasks completed!`);
    }

    config.relationship = relationship;
    this.saveConfigV2(config);
  }

  /**
   * Set the user's name
   */
  static setUserName(name: string): void {
    const config = this.loadConfigV2();
    const sanitizedName = sanitizeStoredPreferredName(name);
    config.relationship = {
      ...config.relationship,
      userName: sanitizedName || undefined,
    } as RelationshipData;
    this.saveConfigV2(config);
  }

  /**
   * Get the user's name
   */
  static getUserName(): string | undefined {
    return this.loadConfigV2().relationship?.userName;
  }

  /**
   * Get all available personality definitions
   */
  static getDefinitions(): PersonalityDefinition[] {
    return PERSONALITY_DEFINITIONS;
  }

  private static sanitizeRelationshipData(
    relationship: RelationshipData | undefined,
  ): RelationshipData {
    const normalized = {
      ...DEFAULT_RELATIONSHIP,
      ...relationship,
    } as RelationshipData;

    const sanitizedName = sanitizeStoredPreferredName(normalized.userName);
    if (sanitizedName) {
      normalized.userName = sanitizedName;
      return normalized;
    }

    if (typeof normalized.userName === "string" && normalized.userName.trim().length > 0) {
      normalized.userName = undefined;
    }

    return normalized;
  }

  /**
   * Get all available persona definitions
   */
  static getPersonaDefinitions(): PersonaDefinition[] {
    return PERSONA_DEFINITIONS;
  }

  /**
   * Get the agent's name
   */
  static getAgentName(): string {
    return this.loadConfigV2().agentName || DEFAULT_AGENT_NAME;
  }

  /**
   * Set the agent's name
   */
  static setAgentName(name: string): void {
    const config = this.loadConfigV2();
    config.agentName = name.trim() || DEFAULT_AGENT_NAME;
    this.saveConfigV2(config);
  }

  /**
   * Update response style preferences
   */
  static setResponseStyle(style: Partial<ResponseStylePreferences>): void {
    const config = this.loadConfigV2();
    config.style = {
      ...config.style,
      ...style,
    };
    this.saveConfigV2(config);
  }

  /**
   * Update personality quirks
   */
  static setQuirks(quirks: Partial<PersonalityQuirks>): void {
    const config = this.loadConfigV2();
    config.quirks = {
      ...config.quirks,
      ...quirks,
    };
    this.saveConfigV2(config);
  }

  /**
   * Get relationship stats for display
   */
  static getRelationshipStats(): {
    tasksCompleted: number;
    projectsCount: number;
    daysTogether: number;
    nextMilestone: number | null;
  } {
    const config = this.loadConfigV2();
    const relationship = config.relationship || DEFAULT_RELATIONSHIP;

    const tasksCompleted = relationship.tasksCompleted || 0;
    const projectsCount = relationship.projectsWorkedOn?.length || 0;
    const daysTogether = relationship.firstInteraction
      ? Math.floor((Date.now() - relationship.firstInteraction) / (1000 * 60 * 60 * 24))
      : 0;

    // Find next milestone
    let nextMilestone: number | null = null;
    for (const milestone of MILESTONES) {
      if (milestone > tasksCompleted) {
        nextMilestone = milestone;
        break;
      }
    }

    return { tasksCompleted, projectsCount, daysTogether, nextMilestone };
  }

  /**
   * Clear the settings cache
   */
  static clearCache(): void {
    this.cachedSettings = null;
    this.cachedConfigV2 = null;
  }

  /**
   * Render SOUL.md markdown from structured config (for export and preview)
   */
  static renderSoulDocument(config: PersonalityConfigV2): string {
    const lines: string[] = ["# SOUL", "## Personality"];
    const traitStr = config.traits
      .map((t) => `${t.label}: ${t.intensity}`)
      .join(", ");
    if (traitStr) lines.push(traitStr);
    lines.push("");

    if (config.rules?.length) {
      lines.push("## Rules");
      config.rules.filter((r) => r.enabled).forEach((r) => lines.push(`- ${r.type.toUpperCase()}: ${r.rule}`));
      lines.push("");
    }

    if (config.expertise?.length) {
      lines.push("## Expertise");
      config.expertise.forEach((e) =>
        lines.push(`- ${e.domain} (${e.level})${e.notes ? `: ${e.notes}` : ""}`),
      );
      lines.push("");
    }

    if (config.customInstructions?.aboutUser || config.customInstructions?.responseGuidance) {
      lines.push("## Instructions");
      if (config.customInstructions.aboutUser)
        lines.push("### About the User", config.customInstructions.aboutUser, "");
      if (config.customInstructions.responseGuidance)
        lines.push("### Response Guidance", config.customInstructions.responseGuidance, "");
    }

    lines.push("## Style");
    const s = config.style;
    lines.push(
      `Emoji: ${s.emojiUsage}, Length: ${s.responseLength}, Formality: ${s.formality}, Structure: ${s.structurePreference}`,
    );
    lines.push("");

    if (config.examples?.length) {
      lines.push("## Examples");
      config.examples.forEach((ex, i) => {
        lines.push(`### Example ${i + 1}`, `**User:** ${ex.userMessage}`, `**Assistant:** ${ex.idealResponse}`, "");
      });
    }

    if (config.contextOverrides?.length) {
      lines.push("## Context Overrides");
      config.contextOverrides.forEach((o) => {
        lines.push(`### ${o.mode}`);
        if (o.styleOverrides) {
          const so = o.styleOverrides;
          if (so.responseLength) lines.push(`Length: ${so.responseLength}`);
          if (so.explanationDepth) lines.push(`Depth: ${so.explanationDepth}`);
        }
        lines.push("");
      });
    }

    return lines.join("\n").trim();
  }

  /**
   * Parse SOUL.md back into structured fields (best-effort)
   */
  static parseSoulDocument(md: string): Partial<PersonalityConfigV2> {
    const result: Partial<PersonalityConfigV2> = {};
    const sections = md.split(/(?=^## )/m);
    for (const sec of sections) {
      const [head, ...body] = sec.split("\n");
      const content = body.join("\n").trim();
      if (head?.includes("Personality") && content) {
        const traitMatches = content.matchAll(/(\w+):\s*(\d+)/g);
        const traits = [...traitMatches].map((m) => ({
          id: m[1].toLowerCase(),
          label: m[1],
          intensity: Math.min(100, Math.max(0, parseInt(m[2], 10))),
          description: "",
        }));
        if (traits.length) result.traits = traits;
      } else if (head?.includes("Rules") && content) {
        const rules: BehavioralRule[] = [];
        const ruleRe = /-\s*(ALWAYS|NEVER|PREFER|AVOID):\s*(.+)/gi;
        let m;
        while ((m = ruleRe.exec(content))) {
          rules.push({
            id: `rule-${rules.length}`,
            type: m[1].toLowerCase() as BehavioralRule["type"],
            rule: m[2].trim(),
            enabled: true,
          });
        }
        if (rules.length) result.rules = rules;
      } else if (head?.includes("About the User") && content) {
        if (!result.customInstructions) result.customInstructions = { ...DEFAULT_CUSTOM_INSTRUCTIONS };
        result.customInstructions.aboutUser = content;
      } else if (head?.includes("Response Guidance") && content) {
        if (!result.customInstructions) result.customInstructions = { ...DEFAULT_CUSTOM_INSTRUCTIONS };
        result.customInstructions.responseGuidance = content;
      } else if (head?.includes("Expertise") && content) {
        const expertise: { id: string; domain: string; level: "familiar" | "proficient" | "expert"; notes?: string }[] = [];
        const exRe = /-\s*(.+?)\s*\((\w+)\)(?:\s*:\s*(.+))?/g;
        const validLevels = ["familiar", "proficient", "expert"];
        let em;
        while ((em = exRe.exec(content))) {
          const level = validLevels.includes(em[2].toLowerCase())
            ? em[2].toLowerCase() as "familiar" | "proficient" | "expert"
            : "proficient";
          expertise.push({
            id: `ex-${expertise.length}`,
            domain: em[1].trim(),
            level,
            notes: em[3]?.trim(),
          });
        }
        if (expertise.length) result.expertise = expertise;
      }
    }
    return result;
  }

  /**
   * Export profile as JSON or SOUL.md
   */
  static exportProfile(format: "json" | "md" = "json"): string {
    const config = this.loadConfigV2();
    if (format === "md") {
      return this.renderSoulDocument(config);
    }
    return JSON.stringify(
      {
        ...config,
        metadata: {
          ...config.metadata,
          exportedAt: Date.now(),
        },
      },
      null,
      2,
    );
  }

  /**
   * Import profile from JSON or SOUL.md string
   */
  static importProfile(data: string): PersonalityConfigV2 {
    const trimmed = data.trim();
    let imported: Partial<PersonalityConfigV2>;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      imported = JSON.parse(trimmed) as Partial<PersonalityConfigV2>;
    } else {
      imported = this.parseSoulDocument(trimmed);
    }
    const existing = this.loadConfigV2();
    const merged: PersonalityConfigV2 = {
      ...existing,
      ...imported,
      version: 2,
      traits: imported.traits ?? existing.traits,
      rules: imported.rules ?? existing.rules,
      style: { ...existing.style, ...imported.style },
      quirks: { ...existing.quirks, ...imported.quirks },
      customInstructions: { ...existing.customInstructions, ...imported.customInstructions },
      expertise: imported.expertise ?? existing.expertise,
      examples: imported.examples ?? existing.examples,
      contextOverrides: imported.contextOverrides ?? existing.contextOverrides,
    };
    this.saveConfigV2(merged);
    return merged;
  }

  /**
   * Get preview prompt from draft config without saving
   */
  static getPreviewPrompt(draft: Partial<PersonalityConfigV2>, contextMode?: ContextMode): string {
    const existing = this.loadConfigV2();
    const merged: PersonalityConfigV2 = {
      ...existing,
      ...draft,
      traits: draft.traits ?? existing.traits,
      rules: draft.rules ?? existing.rules,
      style: { ...existing.style, ...draft.style },
      quirks: { ...existing.quirks, ...draft.quirks },
      customInstructions: { ...existing.customInstructions, ...draft.customInstructions },
      expertise: draft.expertise ?? existing.expertise,
      examples: draft.examples ?? existing.examples,
      contextOverrides: draft.contextOverrides ?? existing.contextOverrides,
    };
    return this.buildPromptFromConfig(merged, contextMode);
  }

  private static buildPromptFromConfig(config: PersonalityConfigV2, contextMode?: ContextMode): string {
    if (config.soulDocument?.trim()) {
      const base = config.soulDocument.trim();
      const persona =
        config.activePersona && config.activePersona !== "none"
          ? getPersonaById(config.activePersona)?.promptTemplate
          : "";
      const style = this.getCommunicationStylePrompt(config.style);
      const quirks = this.getQuirksPrompt(config.quirks, config.activePersona);
      return [base, persona, style, quirks].filter(Boolean).join("\n\n");
    }
    const parts: string[] = [];
    const rulesPart = this.renderBehavioralRules(config.rules, contextMode);
    if (rulesPart) parts.push(rulesPart);
    const instructionsPart = this.renderCustomInstructions(config.customInstructions);
    if (instructionsPart) parts.push(instructionsPart);
    const traitsPart = this.renderTraitsPrompt(config.traits);
    if (traitsPart) parts.push(traitsPart);
    const stylePart = this.getCommunicationStylePrompt(config.style);
    if (stylePart) parts.push(stylePart);
    const expertisePart = this.renderExpertisePrompt(config.expertise);
    if (expertisePart) parts.push(expertisePart);
    if (contextMode && contextMode !== "all") {
      const overridePart = this.renderContextOverride(config.contextOverrides, contextMode);
      if (overridePart) parts.push(overridePart);
    }
    const examplesPart = this.renderExamplesPrompt(config.examples);
    if (examplesPart) parts.push(examplesPart);
    const quirksPart = this.getQuirksPrompt(config.quirks, config.activePersona);
    if (quirksPart) parts.push(quirksPart);
    if (config.activePersona && config.activePersona !== "none") {
      const persona = getPersonaById(config.activePersona);
      if (persona?.promptTemplate) parts.push(persona.promptTemplate);
    }
    return parts.join("\n\n");
  }

  /**
   * Get trait presets for quick-start templates
   */
  static getTraitPresets(): Record<string, { name: string; description: string; icon: string; traits: Record<string, number> }> {
    return { ...TRAIT_PRESETS };
  }

  /**
   * Apply trait adjustments (e.g. { warmth: 80 })
   */
  static adjustTraits(adjustments: Record<string, number>): void {
    const config = this.loadConfigV2();
    for (const [id, value] of Object.entries(adjustments)) {
      const t = config.traits.find((x) => x.id === id);
      if (t) {
        t.intensity = Math.min(100, Math.max(0, value));
      }
    }
    this.saveConfigV2(config);
  }

  /**
   * Add a behavioral rule
   */
  static addBehavioralRule(rule: { type: BehavioralRule["type"]; rule: string }): void {
    const config = this.loadConfigV2();
    config.rules = config.rules ?? [];
    config.rules.push({
      id: `rule-${Date.now()}`,
      type: rule.type,
      rule: rule.rule,
      enabled: true,
    });
    this.saveConfigV2(config);
  }

  /**
   * Set expertise for a domain
   */
  static setExpertise(domain: string, level: "familiar" | "proficient" | "expert", notes?: string): void {
    const config = this.loadConfigV2();
    config.expertise = config.expertise ?? [];
    const existing = config.expertise.find((e) => e.domain.toLowerCase() === domain.toLowerCase());
    const entry = { id: existing?.id ?? `ex-${Date.now()}`, domain, level, notes };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      config.expertise.push(entry);
    }
    this.saveConfigV2(config);
  }

  /**
   * Get default settings (V1 format)
   */
  static getDefaults(): PersonalitySettings {
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Reset all settings to defaults
   * This clears everything except relationship data (to preserve task history)
   */
  static resetToDefaults(preserveRelationship = true): void {
    this.ensureInitialized();

    let newConfig: PersonalityConfigV2 = {
      ...this.getDefaultConfigV2(),
      activePersonality: "professional",
    };

    if (preserveRelationship) {
      const current = this.loadConfigV2();
      if (current.relationship) {
        newConfig = { ...newConfig, relationship: { ...current.relationship } };
      }
    }

    if (SecureSettingsRepository.isInitialized()) {
      const repository = SecureSettingsRepository.getInstance();
      repository.save("personality", newConfig);
    }
    this.cachedConfigV2 = newConfig;
    this.cachedSettings = this.configV2ToSettings(newConfig);
    console.log(
      "[PersonalityManager] Settings reset to defaults",
      preserveRelationship ? "(preserved relationship)" : "",
    );
    this.emitSettingsChanged();
  }

  /**
   * Check if the manager has been initialized
   */
  static isInitialized(): boolean {
    return this.initialized;
  }
}

function isValidPersonalityId(value: unknown): value is PersonalityId {
  const validIds: PersonalityId[] = [
    "professional",
    "friendly",
    "concise",
    "creative",
    "technical",
    "casual",
    "custom",
  ];
  return validIds.includes(value as PersonalityId);
}

function isValidPersonaId(value: unknown): value is PersonaId {
  const validIds: PersonaId[] = [
    "none",
    "jarvis",
    "friday",
    "hal",
    "computer",
    "alfred",
    "intern",
    "sensei",
    "pirate",
    "noir",
    "companion",
  ];
  return validIds.includes(value as PersonaId);
}
