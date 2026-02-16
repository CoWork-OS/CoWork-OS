/**
 * Router Helpers
 *
 * Standalone functions, constants, and types extracted from router.ts
 * to reduce the size of the MessageRouter module.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Version helper ──────────────────────────────────────────────────────────

export function getCoworkVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as any;
    const app = electron?.app;
    if (typeof app?.getVersion === 'function') {
      const v = String(app.getVersion() || '').trim();
      if (v) return v;
    }
  } catch {
    // ignore
  }

  const env = process.env.npm_package_version;
  if (typeof env === 'string' && env.trim()) return env.trim();

  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as any;
    const v = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    if (v) return v;
  } catch {
    // ignore
  }

  return 'unknown';
}

// ── Router configuration ────────────────────────────────────────────────────

export interface RouterConfig {
  /** Default workspace ID to use for new sessions */
  defaultWorkspaceId?: string;
  /** Welcome message for new users */
  welcomeMessage?: string;
  /** Message shown when user is not authorized */
  unauthorizedMessage?: string;
  /** Message shown when pairing is required */
  pairingRequiredMessage?: string;
}

export const DEFAULT_CONFIG: RouterConfig = {
  welcomeMessage: '👋 Welcome to CoWork! I can help you with tasks in your workspace.',
  unauthorizedMessage: '⚠️ You are not authorized to use this bot. Please contact the administrator.',
  pairingRequiredMessage: '🔐 Please enter your pairing code to get started.',
};

// ── Timing / tag constants ──────────────────────────────────────────────────

export const STREAMING_UPDATE_DEBOUNCE_MS = 1200;
export const INLINE_ACTION_GUARD_TTL_MS = 10 * 60 * 1000;
export const FEEDBACK_GUARD_TTL_MS = 72 * 60 * 60 * 1000;
export const PENDING_FEEDBACK_TTL_MS = 10 * 60 * 1000;
export const BRIEF_CRON_TAG = 'cowork_brief_v1';
export const SCHEDULE_CRON_TAG = 'cowork_schedule_v1';

// ── Pure utility functions ──────────────────────────────────────────────────

export function sanitizeTempKey(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (safe.length > 0) return safe.slice(0, 120);
  return `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function slugify(value: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug.length > 0 ? slug.slice(0, 60) : 'scheduled-task';
}

export function sanitizePathSegment(raw: string, maxLen = 80): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || 'unknown';
}

export function sanitizeFilename(raw: string, maxLen = 120): string {
  const base = path.basename(String(raw || '').trim() || 'attachment');
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || 'attachment';
}

export function guessExtFromMime(mimeType?: string): string {
  const mime = (mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/bmp') return '.bmp';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'audio/ogg') return '.ogg';
  if (mime === 'audio/wav') return '.wav';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx';
  if (mime === 'application/vnd.ms-powerpoint') return '.ppt';
  return '';
}

export function toPosixRelPath(workspacePath: string, absPath: string): string {
  const rel = path.relative(workspacePath, absPath);
  return rel.split(path.sep).join('/');
}

// ── Voice / audio helpers ───────────────────────────────────────────────────

import * as os from 'os';
import type { IncomingMessage } from './channels/types';
import { getVoiceService } from '../voice/VoiceService';

export async function transcribeAudioAttachments(message: IncomingMessage, workspacePath?: string): Promise<void> {
  if (!message.attachments || message.attachments.length === 0) {
    return;
  }

  const audioAttachments = message.attachments.filter(a => a.type === 'audio');
  if (audioAttachments.length === 0) {
    return;
  }

  const voiceService = getVoiceService();

  // Check if transcription is available
  if (!voiceService.isTranscriptionAvailable()) {
    console.log('[Router] Audio transcription not available - no STT provider configured');
    // Add placeholder for audio messages
    for (const attachment of audioAttachments) {
      const fileName = attachment.fileName || 'voice message';
      message.text += message.text ? `\n[Audio: ${fileName} - transcription unavailable]` : `[Audio: ${fileName} - transcription unavailable]`;
    }
    return;
  }

  console.log(`[Router] Transcribing ${audioAttachments.length} audio attachment(s)...`);

  for (const attachment of audioAttachments) {
    let savedAudioPath: string | undefined;
    try {
      let audioBuffer: Buffer | undefined;

      // Get audio data from buffer or file
      if (attachment.data) {
        audioBuffer = attachment.data;
      } else if (attachment.url) {
        // Check if it's a local file path
        if (attachment.url.startsWith('/') || attachment.url.startsWith('file://')) {
          const filePath = attachment.url.replace('file://', '');
          if (fs.existsSync(filePath)) {
            audioBuffer = fs.readFileSync(filePath);
          }
        } else if (attachment.url.startsWith('http')) {
          // Download from URL
          try {
            const response = await fetch(attachment.url);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              audioBuffer = Buffer.from(arrayBuffer);
            }
          } catch (fetchError) {
            console.error('[Router] Failed to download audio:', fetchError);
          }
        }
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        console.log('[Router] No audio data available for transcription');
        const fileName = attachment.fileName || 'voice message';
        message.text += message.text ? `\n[Audio: ${fileName} - could not load]` : `[Audio: ${fileName} - could not load]`;
        continue;
      }

      // Save audio file to temp directory for transcription
      try {
        const tempDir = path.join(os.tmpdir(), 'cowork-audio');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const audioFileName = attachment.fileName || `voice_message_${Date.now()}.ogg`;
        savedAudioPath = path.join(tempDir, audioFileName);
        fs.writeFileSync(savedAudioPath, audioBuffer);
        console.log(`[Router] Saved audio file to: ${savedAudioPath}`);
      } catch (saveError) {
        console.error('[Router] Failed to save audio file:', saveError);
      }

      // Transcribe the audio
      const transcript = await voiceService.transcribe(audioBuffer, { force: true });

      if (transcript && transcript.trim()) {
        console.log(`[Router] Transcribed audio: "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"`);

        // Create a structured message with the full transcript
        // This ensures the agent knows it's a voice message and has the complete transcript
        const voiceMessageContext = [
          '📢 **Voice Message Received**',
          '',
          'The user sent a voice message. Here is the complete transcription:',
          '',
          '---',
          transcript,
          '---',
          '',
          'Please respond to the user\'s voice message above.',
        ].filter(line => line !== undefined).join('\n');

        // Append or set the transcribed text with context
        if (message.text && message.text.trim()) {
          message.text += `\n\n${voiceMessageContext}`;
        } else {
          message.text = voiceMessageContext;
        }
      } else {
        const fileName = attachment.fileName || 'voice message';
        message.text += message.text ? `\n[Audio: ${fileName} - no speech detected]` : `[Audio: ${fileName} - no speech detected]`;
      }
    } catch (error) {
      console.error('[Router] Failed to transcribe audio:', error);
      const fileName = attachment.fileName || 'voice message';
      message.text += message.text ? `\n[Audio: ${fileName} - transcription failed]` : `[Audio: ${fileName} - transcription failed]`;
    } finally {
      if (savedAudioPath && fs.existsSync(savedAudioPath)) {
        try {
          fs.unlinkSync(savedAudioPath);
        } catch (cleanupError) {
          console.error('[Router] Failed to delete temp audio file:', cleanupError);
        }
      }
    }
  }
}

export function extractVoiceTranscriptFromMessageText(text: string): string | null {
  const raw = String(text || '');
  if (!raw) return null;
  const match = raw.match(/Voice Message Received[\s\S]*?\n---\n([\s\S]*?)\n---/i);
  if (match && match[1] && String(match[1]).trim()) {
    return String(match[1]).trim();
  }
  return null;
}

// ── Date / time helpers ─────────────────────────────────────────────────────

export function formatLocalTimestamp(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function parseTimeOfDay(input: string): { hour: number; minute: number } | null {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  const hRaw = parseInt(match[1], 10);
  const mRaw = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (!Number.isFinite(hRaw) || !Number.isFinite(mRaw)) return null;
  if (mRaw < 0 || mRaw > 59) return null;

  let hour = hRaw;
  const minute = mRaw;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') {
      if (hour === 12) hour = 0;
    } else if (meridiem === 'pm') {
      if (hour !== 12) hour += 12;
    }
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return { hour, minute };
}

export function parseWeekday(input: string): number | null {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return null;
  const map: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : null;
}

// ── Prompt builders ─────────────────────────────────────────────────────────

export function buildBriefPrompt(mode: 'morning' | 'today' | 'tomorrow' | 'week', opts?: { templateForCron?: boolean }): string {
  const templateForCron = opts?.templateForCron === true;
  const normalizedMode = mode === 'morning' ? 'today' : mode;

  const formatLocalYmd = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const now = new Date();
  const today = formatLocalYmd(now);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(now.getDate() + 1);
  const tomorrow = formatLocalYmd(tomorrowDate);
  const weekEndDate = new Date(now);
  weekEndDate.setDate(now.getDate() + 6);
  const weekEnd = formatLocalYmd(weekEndDate);

  const rangeText = templateForCron
    ? (normalizedMode === 'today'
      ? 'Date: {{today}}'
      : normalizedMode === 'tomorrow'
        ? 'Date: {{tomorrow}}'
        : 'Range: {{today}} to {{week_end}}')
    : (normalizedMode === 'today'
      ? `Date: ${today}`
      : normalizedMode === 'tomorrow'
        ? `Date: ${tomorrow}`
        : `Range: ${today} to ${weekEnd}`);

  return [
    'Generate a concise chief-of-staff brief.',
    '',
    `Timeframe: ${mode}`,
    rangeText,
    '',
    'Include sections:',
    '- Executive summary: 3-6 bullets of what matters most right now.',
    '- Calendar: upcoming events in this timeframe (times, locations if available, conflicts, prep items).',
    '- Inbox triage: important new messages/emails that likely need action, grouped as urgent/today/this-week.',
    '- Reminders / tasks: anything due soon, including likely blockers.',
    '- Ops signals (optional): notable GitHub notifications, revenue/payment changes, weather, and market/context signals if available.',
    '- Suggested next actions: 4-8 bullet items ordered by urgency with explicit owner and suggested timing.',
    '- Missing data: briefly note sources that were unavailable so the user knows what to connect.',
    '',
    'Data sources (use what is available):',
    '- Prefer calendar_action + gmail_action if configured. If calendar_action is unavailable and you are on macOS, use apple_calendar_action for Apple Calendar.',
    '- If gmail_action is unavailable, use email_imap_unread if available; otherwise use the Email channel message log via channel_list_chats/channel_history.',
    '- If Apple Reminders is available on this machine, use apple_reminders_action to include relevant reminders; otherwise skip reminders.',
    '- If weather tools are available (or web_fetch/search access is enabled), include a short weather signal for key travel/meeting windows.',
    '- If GitHub/Stripe/finance MCP tools are connected, include only high-signal changes (e.g., failing builds, urgent mentions, unusual revenue movement).',
    '- For newsletter load, use channel history digests if relevant and available.',
    '',
    'Output should be readable on mobile and suitable for Telegram/WhatsApp delivery.',
    'Use short bullets, no long paragraphs, and never fabricate unavailable data.',
  ].join('\n');
}

export function buildInboxPrompt(opts?: {
  mode?: 'triage' | 'autopilot' | 'followups';
  maxMessages?: number;
}): string {
  const mode = opts?.mode ?? 'triage';
  const rawMaxMessages = typeof opts?.maxMessages === 'number' ? opts.maxMessages : Number.NaN;
  const maxMessages = Number.isFinite(rawMaxMessages)
    ? Math.max(20, Math.min(300, Math.trunc(rawMaxMessages)))
    : 120;

  const modeGuidance = mode === 'autopilot'
    ? 'Focus on full inbox autopilot recommendations (prioritize, cleanup, and draft responses).'
    : mode === 'followups'
      ? 'Focus on extracting follow-ups and commitments that need replies.'
      : 'Focus on fast inbox triage and priority sorting.';

  return [
    'Run an inbox manager workflow.',
    '',
    `Mode: ${mode}`,
    `Message limit target: ${maxMessages}`,
    '',
    modeGuidance,
    '',
    'Data collection (use available sources in this order):',
    '- Prefer gmail_action (search/list/read) when configured.',
    '- Fallback to email_imap_unread for unread mailbox access.',
    '- If email APIs are unavailable, use Email channel logs via channel_list_chats + channel_history.',
    '',
    `Fetch up to ${maxMessages} recent/unread items and classify each as: urgent, today, this-week, or no-action.`,
    '',
    'Required output:',
    '- Priority triage table (sender, subject, category, why it matters).',
    '- Reply-needed list with concise draft replies.',
    '- Cleanup candidates (newsletters/promotions) with unsubscribe/archive suggestions.',
    '- Follow-up queue with suggested reminders.',
    '- Proposed automation rules the user can schedule (for example daily triage or newsletter digests).',
    '',
    'Safety rules:',
    '- Do not send, archive, delete, label, unsubscribe, or contact anyone without explicit user confirmation.',
    '- If any required capability is missing, report exactly what is missing and continue with available data.',
    '- Keep output concise and mobile-friendly.',
  ].join('\n');
}

// ── Markdown helpers ────────────────────────────────────────────────────────

export function updatePrioritiesMarkdown(
  markdown: string,
  extracted: {
    priorities?: string[];
    decisions?: string[];
    actionItems?: string[];
    contextShifts?: string[];
  },
  timestamp: string
): string {
  const lines = String(markdown || '').split('\n');
  const sanitize = (s: string) =>
    String(s || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const clean = (s: string) => {
    const trimmed = sanitize(s).replace(/^[-*]\s+/, '').trim();
    return trimmed.length > 220 ? trimmed.slice(0, 217) + '...' : trimmed;
  };

  const incomingPriorities = (extracted.priorities || [])
    .map((p) => clean(p))
    .filter((p) => p.length > 0)
    .slice(0, 8);

  const incomingDecisions = (extracted.decisions || [])
    .map((p) => clean(p))
    .filter((p) => p.length > 0)
    .slice(0, 8);
  const incomingActionItems = (extracted.actionItems || [])
    .map((p) => clean(p))
    .filter((p) => p.length > 0)
    .slice(0, 8);
  const incomingContextShifts = (extracted.contextShifts || [])
    .map((p) => clean(p))
    .filter((p) => p.length > 0)
    .slice(0, 8);

  const hasAnyIncoming =
    incomingPriorities.length > 0
    || incomingDecisions.length > 0
    || incomingActionItems.length > 0
    || incomingContextShifts.length > 0;

  if (!hasAnyIncoming) return markdown;

  const idxCurrent = lines.findIndex((l) => /^##\s+Current\s*$/.test(l));
  if (idxCurrent >= 0 && incomingPriorities.length > 0) {
    let idxEnd = lines.length;
    for (let i = idxCurrent + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        idxEnd = i;
        break;
      }
    }

    const existingItems: string[] = [];
    for (let i = idxCurrent + 1; i < idxEnd; i++) {
      const m = lines[i].match(/^\s*\d+\.\s*(.*)$/);
      if (m) {
        const v = clean(m[1] || '');
        if (v) existingItems.push(v);
      }
    }

    const seen = new Set<string>();
    const merged: string[] = [];
    for (const p of [...incomingPriorities, ...existingItems]) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
      if (merged.length >= 5) break;
    }

    const rendered: string[] = [];
    const count = Math.max(3, merged.length);
    for (let i = 0; i < count; i++) {
      rendered.push(`${i + 1}. ${merged[i] || ''}`.trimEnd());
    }

    lines.splice(idxCurrent + 1, idxEnd - (idxCurrent + 1), ...rendered, '');
  }

  const idxHistory = lines.findIndex((l) => /^##\s+History\s*$/.test(l));
  if (idxHistory >= 0) {
    const entryLines: string[] = [];
    entryLines.push(`### ${timestamp}`);
    if (incomingPriorities.length > 0) {
      entryLines.push(`- Priorities: ${incomingPriorities.join(' | ')}`);
    }
    if (incomingDecisions.length > 0) {
      entryLines.push(`- Decisions: ${incomingDecisions.join(' | ')}`);
    }
    if (incomingActionItems.length > 0) {
      entryLines.push(`- Action Items: ${incomingActionItems.join(' | ')}`);
    }
    if (incomingContextShifts.length > 0) {
      entryLines.push(`- Context Shifts: ${incomingContextShifts.join(' | ')}`);
    }
    entryLines.push('');
    lines.splice(idxHistory + 1, 0, ...entryLines);
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}
