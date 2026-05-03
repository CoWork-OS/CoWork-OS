/**
 * ChatGPT History Importer
 *
 * Securely parses a ChatGPT data export (conversations.json),
 * distils conversations into memory entries via LLM, and stores
 * them through the MemoryRepository directly (bypassing auto-capture
 * checks so imports always work regardless of settings).
 *
 * Security guarantees:
 * - Raw export is read once; the full file is never persisted to disk
 *   by CoWork OS.
 * - All content (including conversation titles) is sanitized through
 *   InputSanitizer before storage.
 * - Sensitive-data detection marks memories as private automatically.
 * - After import the caller is reminded to delete the source file.
 */

import * as fs from "fs/promises";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { LLMProviderFactory } from "../agent/llm";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import type { LLMProviderType } from "../../shared/types";
import { InputSanitizer } from "../agent/security";
import { estimateTokens } from "../agent/context-manager";
import {
  MemoryRepository,
  MemoryEmbeddingRepository,
  MemorySettingsRepository,
} from "../database/repositories";
import { DatabaseManager } from "../database/schema";
import { createLocalEmbedding } from "./local-embedding";

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
  phase: "parsing" | "distilling" | "storing" | "done" | "error";
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
  /** Override the LLM provider type for distillation (uses existing credentials). */
  distillProvider?: string;
  /** Override the model ID for distillation (e.g. a cheaper/faster model). */
  distillModel?: string;
  /** Abort signal to cancel an in-progress import. */
  signal?: AbortSignal;
}

// ── Constants ──────────────────────────────────────────────────

/** Max raw file size we will read (500 MB). */
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** Delay between LLM calls to respect rate limits. */
const DISTILL_DELAY_MS = 300;

/** Maximum characters sent to LLM per conversation batch. */
const MAX_DISTILL_INPUT_CHARS = 6000;

/** Max conversations processed in one import. */
const HARD_MAX_CONVERSATIONS = 10000;

/**
 * Patterns that indicate sensitive data in memory content.
 * Mirrors the detection used by MemoryService so imports get the same
 * privacy protection as auto-captured memories.
 */
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/i,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /(?:bearer|token)\s+[A-Za-z0-9\-._~+/]+=*/i,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[bpoas]-[A-Za-z0-9-]+/,
];

function containsSensitiveData(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Importer ───────────────────────────────────────────────────

const importEvents = new EventEmitter();

export class ChatGPTImporter {
  /** Guard against concurrent imports. */
  private static isImporting = false;

  /**
   * Subscribe to progress events during an active import.
   */
  static onProgress(callback: (progress: ChatGPTImportProgress) => void): () => void {
    importEvents.on("progress", callback);
    return () => importEvents.off("progress", callback);
  }

  /**
   * Run the full import pipeline.
   */
  static async import(options: ChatGPTImportOptions): Promise<ChatGPTImportResult> {
    if (this.isImporting) {
      throw new Error("An import is already in progress. Please wait for it to finish.");
    }

    this.isImporting = true;

    try {
      return await this.runImport(options);
    } finally {
      this.isImporting = false;
    }
  }

  private static async runImport(options: ChatGPTImportOptions): Promise<ChatGPTImportResult> {
    const {
      workspaceId,
      filePath,
      maxConversations = 0,
      minMessages = 2,
      forcePrivate = false,
      distillProvider,
      distillModel,
      signal,
    } = options;

    // Get repository directly to bypass autoCapture check
    const db = DatabaseManager.getInstance().getDatabase();
    const memoryRepo = new MemoryRepository(db);
    const embeddingRepo = new MemoryEmbeddingRepository(db);
    const settingsRepo = new MemorySettingsRepository(db);

    const result: ChatGPTImportResult = {
      success: false,
      memoriesCreated: 0,
      conversationsProcessed: 0,
      skipped: 0,
      errors: [],
      sourceFileHash: "",
    };

    try {
      // Check abort before starting
      if (signal?.aborted) {
        throw new Error("Import was cancelled.");
      }

      // Verify memory system is enabled (but ignore autoCapture)
      const settings = settingsRepo.getOrCreate(workspaceId);
      if (!settings.enabled) {
        throw new Error(
          "Memory system is disabled for this workspace. Enable it in settings first.",
        );
      }

      // ── 1. Validate & hash source file ────────────────────
      this.emitProgress({ phase: "parsing", current: 0, total: 0, memoriesCreated: 0 });

      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error("Selected path is not a file.");
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File is too large (${Math.round(stat.size / 1024 / 1024)} MB). Maximum is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`,
        );
      }
      if (stat.size === 0) {
        throw new Error("File is empty.");
      }

      // Hash the source so the user can verify we read the right file
      const rawBuffer = await fs.readFile(filePath);
      result.sourceFileHash = crypto
        .createHash("sha256")
        .update(rawBuffer)
        .digest("hex")
        .slice(0, 16);

      if (signal?.aborted) {
        throw new Error("Import was cancelled.");
      }

      // ── 2. Parse JSON ─────────────────────────────────────
      let conversations: ChatGPTConversation[];
      try {
        const parsed = JSON.parse(rawBuffer.toString("utf-8"));
        conversations = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new Error(
          "Failed to parse file. Make sure this is the conversations.json from a ChatGPT data export.",
        );
      }

      if (conversations.length === 0) {
        throw new Error("No conversations found in the file.");
      }

      // Enforce hard cap
      const cap =
        maxConversations > 0
          ? Math.min(maxConversations, HARD_MAX_CONVERSATIONS)
          : Math.min(conversations.length, HARD_MAX_CONVERSATIONS);

      // Sort by most recent first
      conversations.sort(
        (a, b) => (b.update_time ?? b.create_time ?? 0) - (a.update_time ?? a.create_time ?? 0),
      );
      conversations = conversations.slice(0, cap);

      // ── 2b. Build set of already-imported conversation IDs for resume ──
      const alreadyImported = new Set<string>();
      try {
        const rows = db
          .prepare(
            `SELECT content
             FROM memories
             WHERE workspace_id = ?
               AND (
                 content LIKE '[Imported from ChatGPT %'
                 OR content LIKE '[cowork:prompt_recall=ignore]%[Imported from ChatGPT %'
               )
             LIMIT 100000`,
          )
          .all(workspaceId) as Array<{ content: string }>;
        for (const row of rows) {
          const match = row.content.match(/\(conv:([a-f0-9-]+)\)/);
          if (match) alreadyImported.add(match[1]);
        }
      } catch {
        // If query fails, proceed without dedup
      }

      this.emitProgress({
        phase: "distilling",
        current: 0,
        total: conversations.length,
        memoriesCreated: 0,
      });

      // ── 3. Distil each conversation ───────────────────────
      for (let i = 0; i < conversations.length; i++) {
        // Check abort between conversations
        if (signal?.aborted) {
          result.errors.push("Import was cancelled by user.");
          break;
        }

        const convo = conversations[i];
        const convId = convo.conversation_id || "";
        const rawTitle = convo.title || "Untitled";
        // Sanitize the title before using it anywhere
        const title = InputSanitizer.sanitizeMemoryContent(rawTitle) || "Untitled";

        // Skip already-imported conversations (resume support)
        if (convId && alreadyImported.has(convId)) {
          result.skipped++;
          this.emitProgress({
            phase: "distilling",
            current: i + 1,
            total: conversations.length,
            conversationTitle: title,
            memoriesCreated: result.memoriesCreated,
          });
          continue;
        }

        try {
          const messages = this.extractMessages(convo);

          // Skip short / trivial conversations
          if (messages.length < minMessages) {
            result.skipped++;
            this.emitProgress({
              phase: "distilling",
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
          const distilled = await this.distilConversation(
            transcript,
            title,
            distillProvider,
            distillModel,
          );

          // ── 4. Store memories directly via repository ──────
          this.emitProgress({
            phase: "storing",
            current: i + 1,
            total: conversations.length,
            conversationTitle: title,
            memoriesCreated: result.memoriesCreated,
          });

          for (const entry of distilled) {
            // Sanitize content before storage
            const sanitized = InputSanitizer.sanitizeMemoryContent(entry.content);
            if (!sanitized || sanitized.length < 10) continue;

            const convTag = convId ? ` (conv:${convId})` : "";
            const memoryContent = `[Imported from ChatGPT — "${title}"${convTag}]\n${sanitized}`;
            const tokens = estimateTokens(memoryContent);

            // Write directly to DB, bypassing MemoryService.capture()
            // which checks autoCapture setting and would block imports
            const isPrivate =
              forcePrivate ||
              settings.privacyMode === "strict" ||
              containsSensitiveData(memoryContent);

            const created = memoryRepo.create({
              workspaceId,
              taskId: undefined,
              type: entry.type as "observation" | "decision" | "insight",
              content: memoryContent,
              tokens,
              isCompressed: false,
              isPrivate,
            });

            // Best-effort: store offline embedding so imported histories are immediately
            // searchable with hybrid retrieval (no reindex step required).
            try {
              const embedText = sanitized;
              const embedding = createLocalEmbedding(embedText);
              embeddingRepo.upsert(workspaceId, created.id, embedding, created.updatedAt);
            } catch {
              // ignore
            }

            result.memoriesCreated++;
          }

          result.conversationsProcessed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`"${title}": ${msg}`);
        }

        this.emitProgress({
          phase: "distilling",
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

      result.success = !signal?.aborted;
      this.emitProgress({
        phase: "done",
        current: conversations.length,
        total: conversations.length,
        memoriesCreated: result.memoriesCreated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
      this.emitProgress({
        phase: "error",
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
  private static extractMessages(
    convo: ChatGPTConversation,
  ): Array<{ role: string; text: string }> {
    const mapping = convo.mapping;
    if (!mapping) return [];

    const messages: Array<{ role: string; text: string; time: number }> = [];

    for (const node of Object.values(mapping)) {
      const msg = node.message;
      if (!msg) continue;

      const role = msg.author?.role;
      if (!role || (role !== "user" && role !== "assistant")) continue;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;

      const textParts = parts
        .filter((p): p is string => typeof p === "string")
        .join("\n")
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
    messages: Array<{ role: string; text: string }>,
  ): string {
    const lines: string[] = [`Conversation: "${title}"\n`];
    let charCount = lines[0].length;

    for (const msg of messages) {
      const prefix = msg.role === "user" ? "User" : "Assistant";
      // Truncate individual messages that are very long
      const text = msg.text.length > 1500 ? msg.text.slice(0, 1500) + "..." : msg.text;
      const line = `${prefix}: ${text}\n`;

      if (charCount + line.length > MAX_DISTILL_INPUT_CHARS) {
        lines.push("[... rest of conversation truncated for processing ...]");
        break;
      }

      lines.push(line);
      charCount += line.length;
    }

    return lines.join("");
  }

  /**
   * Use the configured LLM to extract structured memories from a conversation.
   */
  private static async distilConversation(
    transcript: string,
    _title: string,
    distillProvider?: string,
    distillModel?: string,
  ): Promise<Array<{ type: string; content: string }>> {
    let providerType = "";
    let modelId = "";
    try {
      // If a provider override is specified, create a provider for that type
      // (credentials are merged from global settings automatically)
      const overrideConfig = distillProvider
        ? {
            type: distillProvider as LLMProviderType,
            ...(distillModel ? { model: distillModel } : {}),
          }
        : undefined;
      const provider = LLMProviderFactory.createProvider(overrideConfig);
      providerType = provider.type;

      // Resolve model ID: explicit override > provider default
      if (distillModel) {
        modelId = distillModel;
      } else {
        const settings = LLMProviderFactory.getSettings();
        const providerType: LLMProviderType = distillProvider
          ? (distillProvider as LLMProviderType)
          : settings.providerType;
        const azureDeployment = settings.azure?.deployment || settings.azure?.deployments?.[0];
        const azureAnthropicDeployment =
          settings.azureAnthropic?.deployment || settings.azureAnthropic?.deployments?.[0];
        modelId = LLMProviderFactory.getModelId(
          settings.modelKey,
          providerType,
          settings.ollama?.model,
          settings.gemini?.model,
          settings.openrouter?.model,
          settings.deepseek?.model,
          settings.openai?.model,
          azureDeployment,
          azureAnthropicDeployment,
          settings.groq?.model,
          settings.xai?.model,
          settings.kimi?.model,
          settings.customProviders,
          settings.bedrock?.model,
        );
      }

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
            role: "user",
            content: transcript,
          },
        ],
      });
      recordLlmCallSuccess(
        {
          sourceKind: "chatgpt_import_distill",
          providerType,
          modelKey: modelId,
          modelId,
        },
        response.usage,
      );

      // Extract text from response
      let responseText = "";
      for (const content of response.content) {
        if (content.type === "text") {
          responseText += content.text;
        }
      }
      responseText = responseText.trim();

      // Strip markdown fences if present
      responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

      // If the response isn't valid JSON directly, try to extract a JSON array from it
      // (some models prepend conversational text before the JSON)
      let items: unknown;
      try {
        items = JSON.parse(responseText);
      } catch {
        const arrayMatch = responseText.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          items = JSON.parse(arrayMatch[0]);
        } else {
          return [];
        }
      }
      if (!Array.isArray(items)) return [];

      // Validate structure
      return items
        .filter(
          (item: unknown): item is { type: string; content: string } =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            "content" in item &&
            typeof (item as Record<string, unknown>).type === "string" &&
            typeof (item as Record<string, unknown>).content === "string" &&
            ["observation", "decision", "insight"].includes(
              (item as Record<string, unknown>).type as string,
            ),
        )
        .slice(0, 5); // Hard cap per conversation
    } catch (err) {
      recordLlmCallError(
        {
          sourceKind: "chatgpt_import_distill",
          providerType,
          modelKey: modelId,
          modelId,
        },
        err,
      );
      console.warn("[ChatGPTImporter] Distillation failed:", err);
      return [];
    }
  }

  private static emitProgress(progress: ChatGPTImportProgress): void {
    importEvents.emit("progress", progress);
  }
}
