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

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
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
} from '../../shared/types';
import { SecureSettingsRepository } from '../database/SecureSettingsRepository';

const LEGACY_SETTINGS_FILE = 'personality-settings.json';

const DEFAULT_AGENT_NAME = 'CoWork';

const DEFAULT_SETTINGS: PersonalitySettings = {
  activePersonality: 'professional',
  customPrompt: '',
  customName: 'Custom Assistant',
  agentName: DEFAULT_AGENT_NAME,
  activePersona: 'none',
  responseStyle: DEFAULT_RESPONSE_STYLE,
  quirks: DEFAULT_QUIRKS,
  relationship: DEFAULT_RELATIONSHIP,
};

// Milestone thresholds for celebrations
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

// Event emitter for personality settings changes
const personalityEvents = new EventEmitter();

export class PersonalityManager {
  private static legacySettingsPath: string;
  private static cachedSettings: PersonalitySettings | null = null;
  private static initialized = false;
  private static migrationCompleted = false;

  /**
   * Subscribe to settings changed events.
   * The callback receives the updated settings.
   */
  static onSettingsChanged(callback: (settings: PersonalitySettings) => void): () => void {
    personalityEvents.on('settingsChanged', callback);
    return () => personalityEvents.off('settingsChanged', callback);
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
    if (this.cachedSettings) {
      personalityEvents.emit('settingsChanged', this.cachedSettings);
    }
  }

  /**
   * Initialize the PersonalityManager
   */
  static initialize(): void {
    if (this.initialized) {
      return; // Already initialized
    }
    const userDataPath = app.getPath('userData');
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    this.initialized = true;
    console.log('[PersonalityManager] Initialized');

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
        console.log('[PersonalityManager] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists('personality')) {
        console.log('[PersonalityManager] Settings already in database, skipping migration');
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[PersonalityManager] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[PersonalityManager] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const parsed = JSON.parse(data);
        const legacySettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          responseStyle: { ...DEFAULT_RESPONSE_STYLE, ...parsed.responseStyle },
          quirks: { ...DEFAULT_QUIRKS, ...parsed.quirks },
          relationship: { ...DEFAULT_RELATIONSHIP, ...parsed.relationship },
        };

        // Save to encrypted database
        repository.save('personality', legacySettings);
        console.log('[PersonalityManager] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[PersonalityManager] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[PersonalityManager] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[PersonalityManager] Migration failed:', error);
    }
  }

  /**
   * Ensure the manager is initialized before use
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('[PersonalityManager] Not initialized. Call PersonalityManager.initialize() first.');
    }
  }

  /**
   * Load settings from encrypted database (with caching)
   */
  static loadSettings(): PersonalitySettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    // Deep copy DEFAULT_SETTINGS to avoid mutating the original constants
    let settings: PersonalitySettings = {
      ...DEFAULT_SETTINGS,
      responseStyle: { ...DEFAULT_RESPONSE_STYLE },
      quirks: { ...DEFAULT_QUIRKS },
      relationship: { ...DEFAULT_RELATIONSHIP },
    };

    try {
      // Try to load from encrypted database
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PersonalitySettings>('personality');
        if (stored) {
          settings = {
            ...DEFAULT_SETTINGS,
            ...stored,
            responseStyle: { ...DEFAULT_RESPONSE_STYLE, ...stored.responseStyle },
            quirks: { ...DEFAULT_QUIRKS, ...stored.quirks },
            relationship: { ...DEFAULT_RELATIONSHIP, ...stored.relationship },
          };
        }
      }

      // Validate values
      if (!isValidPersonalityId(settings.activePersonality)) {
        settings.activePersonality = DEFAULT_SETTINGS.activePersonality;
      }
      if (!isValidPersonaId(settings.activePersona)) {
        settings.activePersona = DEFAULT_SETTINGS.activePersona;
      }
    } catch (error) {
      console.error('[PersonalityManager] Failed to load settings:', error);
      // Deep copy DEFAULT_SETTINGS to avoid mutating the original constants
      settings = {
        ...DEFAULT_SETTINGS,
        responseStyle: { ...DEFAULT_RESPONSE_STYLE },
        quirks: { ...DEFAULT_QUIRKS },
        relationship: { ...DEFAULT_RELATIONSHIP },
      };
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: PersonalitySettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      // Load existing settings to preserve fields not being updated
      const existingSettings = this.loadSettings();

      // Validate and merge with existing settings
      const validatedSettings: PersonalitySettings = {
        activePersonality: isValidPersonalityId(settings.activePersonality)
          ? settings.activePersonality
          : existingSettings.activePersonality,
        customPrompt: settings.customPrompt ?? existingSettings.customPrompt,
        customName: settings.customName ?? existingSettings.customName,
        agentName: settings.agentName ?? existingSettings.agentName,
        activePersona: isValidPersonaId(settings.activePersona)
          ? settings.activePersona
          : existingSettings.activePersona,
        responseStyle: settings.responseStyle
          ? { ...existingSettings.responseStyle, ...settings.responseStyle }
          : existingSettings.responseStyle,
        quirks: settings.quirks
          ? { ...existingSettings.quirks, ...settings.quirks }
          : existingSettings.quirks,
        relationship: settings.relationship
          ? { ...existingSettings.relationship, ...settings.relationship }
          : existingSettings.relationship,
      };

      const repository = SecureSettingsRepository.getInstance();
      repository.save('personality', validatedSettings);
      this.cachedSettings = validatedSettings;
      console.log('[PersonalityManager] Settings saved to encrypted database');
      this.emitSettingsChanged();
    } catch (error) {
      console.error('[PersonalityManager] Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Set the active personality
   */
  static setActivePersonality(personalityId: PersonalityId): void {
    const settings = this.loadSettings();
    settings.activePersonality = personalityId;
    this.saveSettings(settings);
  }

  /**
   * Set the active persona
   */
  static setActivePersona(personaId: PersonaId): void {
    const settings = this.loadSettings();
    settings.activePersona = personaId;

    // Optionally apply persona's suggested name and quirks
    const persona = getPersonaById(personaId);
    if (persona && personaId !== 'none') {
      if (persona.suggestedName && !settings.agentName) {
        settings.agentName = persona.suggestedName;
      }
      if (persona.sampleCatchphrase && !settings.quirks?.catchphrase) {
        settings.quirks = {
          ...settings.quirks,
          catchphrase: persona.sampleCatchphrase,
        } as PersonalityQuirks;
      }
      if (persona.sampleSignOff && !settings.quirks?.signOff) {
        settings.quirks = {
          ...settings.quirks,
          signOff: persona.sampleSignOff,
        } as PersonalityQuirks;
      }
    }

    this.saveSettings(settings);
  }

  /**
   * Get the currently active personality definition
   */
  static getActivePersonality(): PersonalityDefinition | undefined {
    const settings = this.loadSettings();
    return getPersonalityById(settings.activePersonality);
  }

  /**
   * Get the currently active persona definition
   */
  static getActivePersona(): PersonaDefinition | undefined {
    const settings = this.loadSettings();
    return getPersonaById(settings.activePersona || 'none');
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
   * Get the full personality prompt combining all elements
   */
  static getPersonalityPrompt(): string {
    const settings = this.loadSettings();
    const parts: string[] = [];

    // 1. Base personality prompt
    if (settings.activePersonality === 'custom') {
      if (settings.customPrompt) {
        parts.push(settings.customPrompt);
      }
    } else {
      const personality = getPersonalityById(settings.activePersonality);
      if (personality?.promptTemplate) {
        parts.push(personality.promptTemplate);
      }
    }

    // 2. Persona overlay (if not 'none')
    if (settings.activePersona && settings.activePersona !== 'none') {
      const persona = getPersonaById(settings.activePersona);
      if (persona?.promptTemplate) {
        parts.push(persona.promptTemplate);
      }
    }

    // 3. Response style preferences
    const stylePrompt = this.getResponseStylePrompt(settings.responseStyle);
    if (stylePrompt) {
      parts.push(stylePrompt);
    }

    // 4. Quirks
    const quirksPrompt = this.getQuirksPrompt(settings.quirks);
    if (quirksPrompt) {
      parts.push(quirksPrompt);
    }

    return parts.join('\n\n');
  }

  /**
   * Generate prompt section for response style preferences
   */
  private static getResponseStylePrompt(style?: ResponseStylePreferences): string {
    if (!style) return '';

    const lines: string[] = ['RESPONSE STYLE PREFERENCES:'];

    // Emoji usage
    switch (style.emojiUsage) {
      case 'none':
        lines.push('- Do NOT use emojis in responses');
        break;
      case 'minimal':
        lines.push('- Use emojis sparingly, only when they add clear value');
        break;
      case 'moderate':
        lines.push('- Feel free to use emojis to enhance communication');
        break;
      case 'expressive':
        lines.push('- Use emojis liberally to make responses engaging and expressive');
        break;
    }

    // Response length
    switch (style.responseLength) {
      case 'terse':
        lines.push('- Keep responses very brief and to the point');
        lines.push('- Omit explanations unless explicitly requested');
        break;
      case 'balanced':
        lines.push('- Provide balanced responses with appropriate detail');
        break;
      case 'detailed':
        lines.push('- Provide comprehensive, detailed responses');
        lines.push('- Include context, explanations, and related information');
        break;
    }

    // Code comment style
    switch (style.codeCommentStyle) {
      case 'minimal':
        lines.push('- When writing code, use minimal comments (only for complex logic)');
        break;
      case 'moderate':
        lines.push('- When writing code, include helpful comments for key sections');
        break;
      case 'verbose':
        lines.push('- When writing code, include detailed comments explaining the approach');
        break;
    }

    // Explanation depth
    switch (style.explanationDepth) {
      case 'expert':
        lines.push('- Assume the user is an expert - skip basic explanations');
        lines.push('- Focus on advanced considerations and edge cases');
        break;
      case 'balanced':
        lines.push('- Balance explanations for a competent but curious user');
        break;
      case 'teaching':
        lines.push('- Explain concepts thoroughly as you would to a student');
        lines.push('- Include "why" explanations and learning opportunities');
        break;
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  /**
   * Generate prompt section for personality quirks
   */
  private static getQuirksPrompt(quirks?: PersonalityQuirks): string {
    if (!quirks) return '';

    const lines: string[] = [];

    if (quirks.catchphrase) {
      lines.push(`- Occasionally use your catchphrase: "${quirks.catchphrase}"`);
    }

    if (quirks.signOff) {
      lines.push(`- End longer responses with your signature sign-off: "${quirks.signOff}"`);
    }

    if (quirks.analogyDomain && quirks.analogyDomain !== 'none') {
      const domain = ANALOGY_DOMAINS[quirks.analogyDomain];
      lines.push(`- When using analogies, prefer ${domain.name.toLowerCase()}-themed examples`);
      if (domain.examples) {
        lines.push(`  Example: ${domain.examples}`);
      }
    }

    return lines.length > 0 ? 'PERSONALITY QUIRKS:\n' + lines.join('\n') : '';
  }

  /**
   * Get the identity prompt that tells the agent who it is
   */
  static getIdentityPrompt(): string {
    const settings = this.loadSettings();
    const agentName = settings.agentName || DEFAULT_AGENT_NAME;
    const relationship = settings.relationship;
    const userName = relationship?.userName;
    const tasksCompleted = relationship?.tasksCompleted || 0;
    const projectsWorkedOn = relationship?.projectsWorkedOn || [];

    let prompt = `YOUR IDENTITY:
You are ${agentName}, an AI assistant built into CoWork OS.
- When asked about your name or identity, say you are "${agentName}"
- Do NOT claim to be Claude, ChatGPT, or any other AI assistant
- You are a customizable assistant that users can personalize`;

    // Add user relationship context
    if (userName) {
      prompt += `\n\nUSER CONTEXT:
- The user's name is "${userName}"
- You have completed ${tasksCompleted} tasks together`;
      if (projectsWorkedOn.length > 0) {
        prompt += `\n- Projects worked on: ${projectsWorkedOn.slice(-5).join(', ')}`;
      }
      prompt += `\n\nWhen asked "who am I?" or similar identity questions, respond with the USER's information (their name, your shared history) - NOT system info.`;
    } else {
      prompt += `\n\nUSER CONTEXT:
- You don't know the user's name yet
- When asked "who am I?", acknowledge you don't know their name and invite them to introduce themselves
- IMPORTANT: When the user introduces themselves (e.g., "I'm Alice", "My name is Bob", "Call me Charlie"),
  use the set_user_name tool IMMEDIATELY to store their name so you can remember it for future conversations`;
    }

    return prompt;
  }

  /**
   * Get a personalized greeting based on relationship data
   */
  static getGreeting(): string {
    const settings = this.loadSettings();
    const agentName = settings.agentName || DEFAULT_AGENT_NAME;
    const userName = settings.relationship?.userName;
    const tasksCompleted = settings.relationship?.tasksCompleted || 0;

    // Check for milestone
    const milestone = this.checkMilestone(tasksCompleted);
    if (milestone) {
      const congratsMessages = [
        `We've completed ${milestone} tasks together!`,
        `${milestone} tasks and counting! Great working with you${userName ? `, ${userName}` : ''}!`,
        `Milestone achieved: ${milestone} tasks completed together!`,
      ];
      return congratsMessages[Math.floor(Math.random() * congratsMessages.length)];
    }

    // Regular greeting
    if (userName) {
      const greetings = [
        `Welcome back, ${userName}!`,
        `Good to see you, ${userName}!`,
        `Hey ${userName}, ready to work?`,
        `${userName}! Let's get things done.`,
      ];
      return greetings[Math.floor(Math.random() * greetings.length)];
    }

    return '';
  }

  /**
   * Check if a milestone was reached
   */
  private static checkMilestone(tasksCompleted: number): number | null {
    const settings = this.loadSettings();
    const lastCelebrated = settings.relationship?.lastMilestoneCelebrated || 0;

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
    const settings = this.loadSettings();
    const relationship = settings.relationship || { ...DEFAULT_RELATIONSHIP };

    relationship.tasksCompleted = (relationship.tasksCompleted || 0) + 1;

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

    settings.relationship = relationship;
    this.saveSettings(settings);
  }

  /**
   * Set the user's name
   */
  static setUserName(name: string): void {
    const settings = this.loadSettings();
    settings.relationship = {
      ...settings.relationship,
      userName: name.trim() || undefined,
    } as RelationshipData;
    this.saveSettings(settings);
  }

  /**
   * Get the user's name
   */
  static getUserName(): string | undefined {
    return this.loadSettings().relationship?.userName;
  }

  /**
   * Get all available personality definitions
   */
  static getDefinitions(): PersonalityDefinition[] {
    return PERSONALITY_DEFINITIONS;
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
    const settings = this.loadSettings();
    return settings.agentName || DEFAULT_AGENT_NAME;
  }

  /**
   * Set the agent's name
   */
  static setAgentName(name: string): void {
    const settings = this.loadSettings();
    settings.agentName = name.trim() || DEFAULT_AGENT_NAME;
    this.saveSettings(settings);
  }

  /**
   * Update response style preferences
   */
  static setResponseStyle(style: Partial<ResponseStylePreferences>): void {
    const settings = this.loadSettings();
    settings.responseStyle = {
      ...DEFAULT_RESPONSE_STYLE,
      ...settings.responseStyle,
      ...style,
    };
    this.saveSettings(settings);
  }

  /**
   * Update personality quirks
   */
  static setQuirks(quirks: Partial<PersonalityQuirks>): void {
    const settings = this.loadSettings();
    settings.quirks = {
      ...DEFAULT_QUIRKS,
      ...settings.quirks,
      ...quirks,
    };
    this.saveSettings(settings);
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
    const settings = this.loadSettings();
    const relationship = settings.relationship || DEFAULT_RELATIONSHIP;

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
  }

  /**
   * Get default settings
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

    // Deep copy DEFAULT_SETTINGS to avoid mutating the original constants
    let newSettings: PersonalitySettings = {
      ...DEFAULT_SETTINGS,
      responseStyle: { ...DEFAULT_RESPONSE_STYLE },
      quirks: { ...DEFAULT_QUIRKS },
      relationship: { ...DEFAULT_RELATIONSHIP },
    };

    if (preserveRelationship) {
      // Load current settings to get relationship data (even if cache is cleared)
      const currentSettings = this.loadSettings();
      if (currentSettings.relationship) {
        // Preserve the relationship data (task count, user name, etc.)
        newSettings.relationship = { ...currentSettings.relationship };
      }
    }

    // Save to encrypted database
    if (SecureSettingsRepository.isInitialized()) {
      const repository = SecureSettingsRepository.getInstance();
      repository.save('personality', newSettings);
    }
    this.cachedSettings = newSettings;
    console.log('[PersonalityManager] Settings reset to defaults', preserveRelationship ? '(preserved relationship)' : '');
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
    'professional',
    'friendly',
    'concise',
    'creative',
    'technical',
    'casual',
    'custom',
  ];
  return validIds.includes(value as PersonalityId);
}

function isValidPersonaId(value: unknown): value is PersonaId {
  const validIds: PersonaId[] = [
    'none',
    'jarvis',
    'friday',
    'hal',
    'computer',
    'alfred',
    'intern',
    'sensei',
    'pirate',
    'noir',
  ];
  return validIds.includes(value as PersonaId);
}
