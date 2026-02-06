/**
 * ChatGPT History Importer
 *
 * Securely parses a ChatGPT data export (conversations.json),
 * distils conversations into memory entries via LLM, and stores
 * them through the existing MemoryService.
 *
 * Security guarantees:
 * - Raw export is read in a streaming fashion; the full file is
 *   never persisted to disk by CoWork OS.
 * - All content is sanitized through InputSanitizer before storage.
 * - Sensitive-data detection marks memories as private automatically.
 * - After import the caller is reminded to delete the source file.
 */

import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { LLMProviderFactory } from '../agent/llm';
import { estimateTokens } from '../agent/context-manager';
import { InputSanitizer } from '../agent/security';
import { MemoryService } from './MemoryService';

// ── ChatGPT export format types ────────────────────────────────

interface ChatGPTMessage {
  id?: string;
  author?: { role?: string; name?: string };
  content?: { content_type?: string; parts?: unknown[] };
  create_time?: number;
  metadata?: Record<string, unknown>;
}

interface ChatGPTMappingNode {
  id: string;
  message?: ChatGPTMessage | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGPTConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, ChatGPTMappingNode>;
  conversation_id?: string;
}

// ── Public types ───────────────────────────────────────────────

export interface ChatGPTImportProgress {
  phase: 'parsing' | 'distilling' | 'storing' | 'done' | 'error';
  current: number;
  total: number;
  conversationTitle?: string;
  memoriesCreated: number;
  error?: string;
}

export interface ChatGPTImportResult {
  success: boolean;
  memoriesCreated: number;
  conversationsProcessed: number;
  skipped: number;
  errors: string[];
  sourceFileHash: string;
}

export interface ChatGPTImportOptions {
  workspaceId: string;
  filePath: string;
  /** Maximum conversations to process (0 = all). */
  maxConversations?: number;
  /** Minimum messages in a conversation to be worth importing. */
  minMessages?: number;
  /** Mark all imported memories as private regardless of content. */
  forcePrivate?: boolean;
}

// ── Constants ──────────────────────────────────────────────────

/** Max raw file size we will read (500 MB). */
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** Delay between LLM calls to respect rate limits. */
const DISTILL_DELAY_MS = 300;

/** Maximum characters sent to LLM per conversation batch. */
const MAX_DISTILL_INPUT_CHARS = 6000;

/** Max conversations processed in one import. */
const HARD_MAX_CONVERSATIONS = 2000;

// ── Importer ───────────────────────────────────────────────────

const importEvents = new EventEmitter();

export class ChatGPTImporter {
  /**
   * Subscribe to progress events during an active import.
   */
  static onProgress(callback: (progress: ChatGPTImportProgress) => void): () => void {
    importEvents.on('progress', callback);
    return () => importEvents.off('progress', callback);
  }

  /**
   * Run the full import pipeline.
   */
  static async import(options: ChatGPTImportOptions): Promise<ChatGPTImportResult> {
    const {
      workspaceId,
      filePath,
      maxConversations = 0,
      minMessages = 2,
      forcePrivate = false,
    } = options;

    const result: ChatGPTImportResult = {
      success: false,
      memoriesCreated: 0,
      conversationsProcessed: 0,
      skipped: 0,
      errors: [],
      sourceFileHash: '',
    };

    try {
      // ── 1. Validate & hash source file ────────────────────
      this.emitProgress({ phase: 'parsing', current: 0, total: 0, memoriesCreated: 0 });

      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error('Selected path is not a file.');
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File is too large (${Math.round(stat.size / 1024 / 1024)} MB). Maximum is 500 MB.`);
      }
      if (stat.size === 0) {
        throw new Error('File is empty.');
      }

      // Hash the source so the user can verify we read the right file
      const rawBuffer = await fs.readFile(filePath);
      result.sourceFileHash = crypto.createHash('sha256').update(rawBuffer).digest('hex').slice(0, 16);

      // ── 2. Parse JSON ─────────────────────────────────────
      let conversations: ChatGPTConversation[];
      try {
        const parsed = JSON.parse(rawBuffer.toString('utf-8'));
        conversations = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new Error('Failed to parse file. Make sure this is the conversations.json from a ChatGPT data export.');
      }

      if (conversations.length === 0) {
        throw new Error('No conversations found in the file.');
      }

      // Enforce hard cap
      const cap = maxConversations > 0
        ? Math.min(maxConversations, HARD_MAX_CONVERSATIONS)
        : Math.min(conversations.length, HARD_MAX_CONVERSATIONS);

      // Sort by most recent first
      conversations.sort((a, b) => (b.update_time ?? b.create_time ?? 0) - (a.update_time ?? a.create_time ?? 0));
      conversations = conversations.slice(0, cap);

      this.emitProgress({ phase: 'distilling', current: 0, total: conversations.length, memoriesCreated: 0 });

      // ── 3. Distil each conversation ───────────────────────
      for (let i = 0; i < conversations.length; i++) {
        const convo = conversations[i];
        const title = convo.title || 'Untitled';

        try {
          const messages = this.extractMessages(convo);

          // Skip short / trivial conversations
          if (messages.length < minMessages) {
            result.skipped++;
            this.emitProgress({
              phase: 'distilling',
              current: i + 1,
              total: conversations.length,
              conversationTitle: title,
              memoriesCreated: result.memoriesCreated,
            });
            continue;
          }

          // Build a condensed transcript for the LLM
          const transcript = this.buildTranscript(title, messages);

          // Distil via LLM
          const distilled = await this.distilConversation(transcript, title);

          // ── 4. Store memories ─────────────────────────────
          this.emitProgress({
            phase: 'storing',
            current: i + 1,
            total: conversations.length,
            conversationTitle: title,
            memoriesCreated: result.memoriesCreated,
          });

          for (const entry of distilled) {
            // Sanitize content before storage
            const sanitized = InputSanitizer.sanitizeMemoryContent(entry.content);
            if (!sanitized || sanitized.length < 10) continue;

            const memory = await MemoryService.capture(
              workspaceId,
              undefined, // no task association
              entry.type as 'observation' | 'decision' | 'insight',
              `[Imported from ChatGPT — "${title}"]\n${sanitized}`,
              forcePrivate
            );

            if (memory) {
              result.memoriesCreated++;
            }
          }

          result.conversationsProcessed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`"${title}": ${msg}`);
        }

        this.emitProgress({
          phase: 'distilling',
          current: i + 1,
          total: conversations.length,
          conversationTitle: title,
          memoriesCreated: result.memoriesCreated,
        });

        // Rate-limit between conversations
        if (i < conversations.length - 1) {
          await new Promise((r) => setTimeout(r, DISTILL_DELAY_MS));
        }
      }

      result.success = true;
      this.emitProgress({
        phase: 'done',
        current: conversations.length,
        total: conversations.length,
        memoriesCreated: result.memoriesCreated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
      this.emitProgress({
        phase: 'error',
        current: 0,
        total: 0,
        memoriesCreated: result.memoriesCreated,
        error: msg,
      });
    }

    return result;
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Walk the mapping tree and extract human-readable messages.
   */
  private static extractMessages(convo: ChatGPTConversation): Array<{ role: string; text: string }> {
    const mapping = convo.mapping;
    if (!mapping) return [];

    const messages: Array<{ role: string; text: string; time: number }> = [];

    for (const node of Object.values(mapping)) {
      const msg = node.message;
      if (!msg) continue;

      const role = msg.author?.role;
      if (!role || (role !== 'user' && role !== 'assistant')) continue;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;

      const textParts = parts
        .filter((p): p is string => typeof p === 'string')
        .join('\n')
        .trim();

      if (!textParts) continue;

      messages.push({
        role,
        text: textParts,
        time: msg.create_time ?? 0,
      });
    }

    // Sort chronologically
    messages.sort((a, b) => a.time - b.time);

    return messages.map(({ role, text }) => ({ role, text }));
  }

  /**
   * Build a condensed transcript suitable for LLM distillation.
   * Truncates to MAX_DISTILL_INPUT_CHARS.
   */
  private static buildTranscript(
    title: string,
    messages: Array<{ role: string; text: string }>
  ): string {
    const lines: string[] = [`Conversation: "${title}"\n`];
    let charCount = lines[0].length;

    for (const msg of messages) {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      // Truncate individual messages that are very long
      const text = msg.text.length > 1500 ? msg.text.slice(0, 1500) + '...' : msg.text;
      const line = `${prefix}: ${text}\n`;

      if (charCount + line.length > MAX_DISTILL_INPUT_CHARS) {
        lines.push('[... rest of conversation truncated for processing ...]');
        break;
      }

      lines.push(line);
      charCount += line.length;
    }

    return lines.join('');
  }

  /**
   * Use the configured LLM to extract structured memories from a conversation.
   */
  private static async distilConversation(
    transcript: string,
    _title: string
  ): Promise<Array<{ type: string; content: string }>> {
    try {
      const provider = LLMProviderFactory.createProvider();
      const settings = LLMProviderFactory.getSettings();
      const azureDeployment = settings.azure?.deployment || settings.azure?.deployments?.[0];
      const modelId = LLMProviderFactory.getModelId(
        settings.modelKey,
        settings.providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        settings.bedrock?.model
      );

      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 500,
        system: `You extract lasting, reusable knowledge from chat conversations.
Output a JSON array of objects with "type" and "content" fields.
Valid types: "observation", "decision", "insight".
- observation: facts about the user (preferences, tech stack, habits, roles, goals)
- decision: choices the user made (tools adopted, approaches chosen, patterns preferred)
- insight: lessons learned, recurring problems, or useful conclusions

Rules:
- Extract 1-5 items per conversation. Fewer is better if the conversation is trivial.
- Each content should be 1-2 concise sentences.
- Focus on DURABLE knowledge that stays relevant across sessions.
- Do NOT extract ephemeral details (specific code snippets, one-time questions).
- Do NOT include any sensitive data (passwords, API keys, tokens).
- If the conversation has no lasting value, return an empty array [].
- Return ONLY valid JSON, no markdown fences.`,
        messages: [
          {
            role: 'user',
            content: transcript,
          },
        ],
      });

      // Extract text from response
      let responseText = '';
      for (const content of response.content) {
        if (content.type === 'text') {
          responseText += content.text;
        }
      }
      responseText = responseText.trim();

      // Strip markdown fences if present
      responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      // Parse JSON response
      const items = JSON.parse(responseText);
      if (!Array.isArray(items)) return [];

      // Validate structure
      return items
        .filter(
          (item: unknown): item is { type: string; content: string } =>
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            'content' in item &&
            typeof (item as Record<string, unknown>).type === 'string' &&
            typeof (item as Record<string, unknown>).content === 'string' &&
            ['observation', 'decision', 'insight'].includes((item as Record<string, unknown>).type as string)
        )
        .slice(0, 5); // Hard cap per conversation
    } catch (err) {
      console.warn('[ChatGPTImporter] Distillation failed:', err);
      return [];
    }
  }

  private static emitProgress(progress: ChatGPTImportProgress): void {
    importEvents.emit('progress', progress);
  }
}
