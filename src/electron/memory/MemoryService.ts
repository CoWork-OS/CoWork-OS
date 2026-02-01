/**
 * Memory Service
 *
 * Core service for the persistent memory system.
 * Handles capture, compression, search, and context injection.
 */

import { EventEmitter } from 'events';
import type { DatabaseManager } from '../database/schema';
import {
  MemoryRepository,
  MemorySummaryRepository,
  MemorySettingsRepository,
  Memory,
  MemorySettings,
  MemorySearchResult,
  MemoryTimelineEntry,
  MemoryType,
  MemoryStats,
} from '../database/repositories';
import { LLMProviderFactory } from '../agent/llm';
import { estimateTokens } from '../agent/context-manager';

// Privacy patterns to exclude - matches common sensitive data patterns
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /auth/i,
  /bearer\s+[a-zA-Z0-9\-_]+/i,
  /ssh[_-]?key/i,
  /private[_-]?key/i,
  /\.env/i,
  /aws[_-]?access/i,
  /aws[_-]?secret/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /ghp_[a-zA-Z0-9]+/i, // GitHub personal access token
  /gho_[a-zA-Z0-9]+/i, // GitHub OAuth token
  /sk-[a-zA-Z0-9]+/i, // OpenAI API key format
  /xox[baprs]-[a-zA-Z0-9-]+/i, // Slack tokens
];

// Events for reactive updates
const memoryEvents = new EventEmitter();

// Minimum tokens before compression is worthwhile
const MIN_TOKENS_FOR_COMPRESSION = 100;

// Compression batch size
const COMPRESSION_BATCH_SIZE = 10;

// Cleanup interval (1 hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Compression delay between items (avoid rate limits)
const COMPRESSION_DELAY_MS = 200;

export class MemoryService {
  private static memoryRepo: MemoryRepository;
  private static summaryRepo: MemorySummaryRepository;
  private static settingsRepo: MemorySettingsRepository;
  private static initialized = false;
  private static compressionQueue: string[] = [];
  private static compressionInProgress = false;
  private static cleanupIntervalHandle?: ReturnType<typeof setInterval>;

  /**
   * Initialize the memory service
   */
  static initialize(dbManager: DatabaseManager): void {
    if (this.initialized) return;

    const db = dbManager.getDatabase();
    this.memoryRepo = new MemoryRepository(db);
    this.summaryRepo = new MemorySummaryRepository(db);
    this.settingsRepo = new MemorySettingsRepository(db);
    this.initialized = true;

    // Start periodic cleanup
    this.cleanupIntervalHandle = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);

    console.log('[MemoryService] Initialized');
  }

  /**
   * Subscribe to memory events
   */
  static onMemoryChanged(
    callback: (data: { type: string; workspaceId: string }) => void
  ): () => void {
    memoryEvents.on('memoryChanged', callback);
    return () => memoryEvents.off('memoryChanged', callback);
  }

  /**
   * Capture an observation from task execution
   */
  static async capture(
    workspaceId: string,
    taskId: string | undefined,
    type: MemoryType,
    content: string,
    isPrivate = false
  ): Promise<Memory | null> {
    this.ensureInitialized();

    // Check settings
    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || !settings.autoCapture) {
      return null;
    }

    // Check privacy mode
    if (settings.privacyMode === 'disabled') {
      return null;
    }

    // Check excluded patterns
    if (this.shouldExclude(content, settings)) {
      return null;
    }

    // Check for sensitive content
    const containsSensitive = this.containsSensitiveData(content);
    const finalIsPrivate = isPrivate || containsSensitive || settings.privacyMode === 'strict';

    // Estimate tokens
    const tokens = estimateTokens(content);

    // Truncate very long content
    const truncatedContent =
      content.length > 10000 ? content.slice(0, 10000) + '\n[... truncated]' : content;

    // Create memory
    const memory = this.memoryRepo.create({
      workspaceId,
      taskId,
      type,
      content: truncatedContent,
      tokens,
      isCompressed: false,
      isPrivate: finalIsPrivate,
    });

    // Queue for compression if enabled and large enough
    if (settings.compressionEnabled && tokens > MIN_TOKENS_FOR_COMPRESSION && !finalIsPrivate) {
      this.compressionQueue.push(memory.id);
      this.processCompressionQueue();
    }

    // Emit event
    memoryEvents.emit('memoryChanged', { type: 'created', workspaceId });

    return memory;
  }

  /**
   * Search memories - Layer 1 of progressive retrieval
   * Returns IDs + brief snippets (~50 tokens each)
   */
  static search(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    this.ensureInitialized();
    return this.memoryRepo.search(workspaceId, query, limit);
  }

  /**
   * Get timeline context - Layer 2 of progressive retrieval
   * Returns surrounding memories for context
   */
  static getTimelineContext(memoryId: string, windowSize = 5): MemoryTimelineEntry[] {
    this.ensureInitialized();
    return this.memoryRepo.getTimelineContext(memoryId, windowSize);
  }

  /**
   * Get full details - Layer 3 of progressive retrieval
   * Only called for specific memories when needed
   */
  static getFullDetails(ids: string[]): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.getFullDetails(ids);
  }

  /**
   * Get memories for a specific task
   */
  static getByTask(taskId: string): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.findByTask(taskId);
  }

  /**
   * Get recent memories for a workspace
   */
  static getRecent(workspaceId: string, limit = 20): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.getRecentForWorkspace(workspaceId, limit);
  }

  /**
   * Get context for injection at task start
   * Returns a formatted string suitable for system prompt
   */
  static getContextForInjection(workspaceId: string, taskPrompt: string): string {
    this.ensureInitialized();

    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      return '';
    }

    // Get recent memories (summaries preferred)
    const recentMemories = this.memoryRepo.getRecentForWorkspace(workspaceId, 5);

    // Search for relevant memories based on task prompt
    let relevantMemories: MemorySearchResult[] = [];
    if (taskPrompt && taskPrompt.length > 10) {
      try {
        // Extract key terms for search
        const searchTerms = this.extractSearchTerms(taskPrompt);
        if (searchTerms) {
          relevantMemories = this.memoryRepo.search(workspaceId, searchTerms, 5);
          // Filter out memories that are already in recent
          const recentIds = new Set(recentMemories.map((m) => m.id));
          relevantMemories = relevantMemories.filter((m) => !recentIds.has(m.id));
        }
      } catch {
        // Search failed, continue without relevant memories
      }
    }

    if (recentMemories.length === 0 && relevantMemories.length === 0) {
      return '';
    }

    const parts: string[] = ['<memory_context>'];
    parts.push('The following memories from previous sessions may be relevant:');

    // Add recent memories (summaries only for token efficiency)
    if (recentMemories.length > 0) {
      parts.push('\n## Recent Activity');
      for (const memory of recentMemories) {
        const text = memory.summary || this.truncate(memory.content, 150);
        const date = new Date(memory.createdAt).toLocaleDateString();
        parts.push(`- [${memory.type}] (${date}) ${text}`);
      }
    }

    // Add relevant memories
    if (relevantMemories.length > 0) {
      parts.push('\n## Relevant to Current Task');
      for (const result of relevantMemories) {
        const date = new Date(result.createdAt).toLocaleDateString();
        parts.push(`- [${result.type}] (${date}) ${result.snippet}`);
      }
    }

    parts.push('</memory_context>');

    return parts.join('\n');
  }

  /**
   * Get or create settings for a workspace
   */
  static getSettings(workspaceId: string): MemorySettings {
    this.ensureInitialized();
    return this.settingsRepo.getOrCreate(workspaceId);
  }

  /**
   * Update settings for a workspace
   */
  static updateSettings(
    workspaceId: string,
    updates: Partial<Omit<MemorySettings, 'workspaceId'>>
  ): void {
    this.ensureInitialized();
    this.settingsRepo.update(workspaceId, updates);
    memoryEvents.emit('memoryChanged', { type: 'settingsUpdated', workspaceId });
  }

  /**
   * Get storage statistics for a workspace
   */
  static getStats(workspaceId: string): MemoryStats {
    this.ensureInitialized();
    return this.memoryRepo.getStats(workspaceId);
  }

  /**
   * Delete all memories for a workspace
   */
  static clearWorkspace(workspaceId: string): void {
    this.ensureInitialized();
    this.memoryRepo.deleteByWorkspace(workspaceId);
    this.summaryRepo.deleteByWorkspace(workspaceId);
    memoryEvents.emit('memoryChanged', { type: 'cleared', workspaceId });
  }

  /**
   * Process compression queue asynchronously
   */
  private static async processCompressionQueue(): Promise<void> {
    if (this.compressionInProgress || this.compressionQueue.length === 0) {
      return;
    }

    this.compressionInProgress = true;

    try {
      // Process in batches
      const batch = this.compressionQueue.splice(0, COMPRESSION_BATCH_SIZE);

      for (const memoryId of batch) {
        await this.compressMemory(memoryId);
        // Small delay to avoid overwhelming the LLM
        await new Promise((resolve) => setTimeout(resolve, COMPRESSION_DELAY_MS));
      }

      // Continue if more items
      if (this.compressionQueue.length > 0) {
        setTimeout(() => this.processCompressionQueue(), 1000);
      }
    } catch (error) {
      console.error('[MemoryService] Compression queue error:', error);
    } finally {
      this.compressionInProgress = false;
    }
  }

  /**
   * Compress a single memory using LLM
   */
  private static async compressMemory(memoryId: string): Promise<void> {
    const memory = this.memoryRepo.findById(memoryId);
    if (!memory || memory.isCompressed || memory.summary) return;

    try {
      // Get LLM provider for compression
      const provider = LLMProviderFactory.createProvider();
      const settings = LLMProviderFactory.getSettings();
      const modelId = LLMProviderFactory.getModelId(
        settings.modelKey,
        settings.providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model
      );

      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 100,
        system: 'You are a helpful assistant that summarizes text concisely.',
        messages: [
          {
            role: 'user',
            content: `Summarize this observation in 1-2 sentences (max 50 words). Focus on the key insight, decision, or action taken. Be concise and factual.

Observation:
${memory.content}

Summary:`,
          },
        ],
      });

      // Extract summary from response
      let summary = '';
      for (const content of response.content) {
        if (content.type === 'text') {
          summary += content.text;
        }
      }
      summary = summary.trim();

      if (summary) {
        const summaryTokens = estimateTokens(summary);
        this.memoryRepo.update(memoryId, {
          summary,
          tokens: summaryTokens,
          isCompressed: true,
        });
      }
    } catch (error) {
      // Log but don't fail - compression is optional enhancement
      console.warn('[MemoryService] Compression failed for memory:', memoryId, error);
    }
  }

  /**
   * Run periodic cleanup based on retention policies
   */
  private static async runCleanup(): Promise<void> {
    if (!this.initialized) return;

    try {
      // Get all workspaces with memories
      const workspacesWithMemories = new Set<string>();

      // Find unique workspace IDs from recent memories
      const recentMemories = this.memoryRepo.getUncompressed(1000);
      for (const memory of recentMemories) {
        workspacesWithMemories.add(memory.workspaceId);
      }

      // Process each workspace
      for (const workspaceId of workspacesWithMemories) {
        const settings = this.settingsRepo.getOrCreate(workspaceId);
        const retentionMs = settings.retentionDays * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - retentionMs;

        const deleted = this.memoryRepo.deleteOlderThan(workspaceId, cutoff);
        if (deleted > 0) {
          console.log(`[MemoryService] Cleaned up ${deleted} old memories for workspace ${workspaceId}`);
        }
      }
    } catch (error) {
      console.error('[MemoryService] Cleanup failed:', error);
    }
  }

  /**
   * Extract search terms from task prompt
   */
  private static extractSearchTerms(prompt: string): string {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'must', 'shall', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into',
      'over', 'after', 'beneath', 'under', 'above', 'and', 'or', 'but',
      'if', 'then', 'else', 'when', 'where', 'why', 'how', 'all', 'each',
      'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
      'very', 'just', 'also', 'now', 'please', 'help', 'me', 'i', 'my',
      'want', 'need', 'like', 'make', 'create', 'add', 'update', 'fix',
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));

    // Take first 5 meaningful words for search
    return words.slice(0, 5).join(' OR ');
  }

  /**
   * Check if content should be excluded
   */
  private static shouldExclude(content: string, settings: MemorySettings): boolean {
    if (!settings.excludedPatterns || settings.excludedPatterns.length === 0) {
      return false;
    }

    for (const pattern of settings.excludedPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(content)) {
          return true;
        }
      } catch {
        // Invalid regex pattern, skip
      }
    }

    return false;
  }

  /**
   * Check if content contains sensitive data
   */
  private static containsSensitiveData(content: string): boolean {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Truncate text to specified length
   */
  private static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Ensure service is initialized
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('[MemoryService] Not initialized. Call MemoryService.initialize() first.');
    }
  }

  /**
   * Shutdown the service
   */
  static shutdown(): void {
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }
    memoryEvents.removeAllListeners();
    this.initialized = false;
    console.log('[MemoryService] Shutdown complete');
  }
}
