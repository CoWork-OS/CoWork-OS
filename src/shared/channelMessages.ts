/**
 * Channel Message Templates
 *
 * Personality-based message templates for messaging channels (Telegram, WhatsApp, Slack, etc.)
 * These messages are used when sending task status updates to external channels.
 *
 * This file is in shared/ so it can be used by both the main process (gateway) and renderer.
 */

import type { PersonalityId, EmojiUsage, PersonalityQuirks } from './types';

/**
 * Message keys for channel notifications
 */
export type ChannelMessageKey =
  | 'taskComplete'
  | 'taskCompleteWithResult'
  | 'taskFailed'
  | 'toolError'
  | 'followUpProcessed'
  | 'followUpFailed'
  | 'approvalNeeded';

/**
 * Context for generating personalized channel messages
 */
export interface ChannelMessageContext {
  agentName: string;
  userName?: string;
  personality: PersonalityId;
  emojiUsage: EmojiUsage;
  quirks: PersonalityQuirks;
}

/**
 * Message templates organized by personality type
 */
const CHANNEL_MESSAGES: Record<PersonalityId, Record<ChannelMessageKey, string>> = {
  professional: {
    taskComplete: 'Complete.',
    taskCompleteWithResult: 'Complete.\n\n{result}',
    taskFailed: 'Task failed: {error}',
    toolError: 'Tool error ({tool}): {error}',
    followUpProcessed: 'Follow-up processed.',
    followUpFailed: 'Follow-up failed: {error}',
    approvalNeeded: 'Approval required.',
  },
  friendly: {
    taskComplete: 'Done! Nice work.',
    taskCompleteWithResult: 'Done!\n\n{result}',
    taskFailed: 'Oops, something went wrong: {error}',
    toolError: 'Hit a snag with {tool}: {error}',
    followUpProcessed: 'Got it!',
    followUpFailed: 'That follow-up hit a bump: {error}',
    approvalNeeded: 'Need your OK on this!',
  },
  concise: {
    taskComplete: 'Done.',
    taskCompleteWithResult: 'Done.\n\n{result}',
    taskFailed: 'Failed: {error}',
    toolError: '{tool} error: {error}',
    followUpProcessed: 'Done.',
    followUpFailed: 'Failed: {error}',
    approvalNeeded: 'Approval?',
  },
  creative: {
    taskComplete: 'Masterpiece complete.',
    taskCompleteWithResult: 'Masterpiece complete.\n\n{result}',
    taskFailed: 'A twist in the tale: {error}',
    toolError: '{tool} encountered a plot twist: {error}',
    followUpProcessed: 'Another piece falls into place.',
    followUpFailed: 'The sequel hit a snag: {error}',
    approvalNeeded: 'Your vision is needed.',
  },
  technical: {
    taskComplete: 'Execution complete.',
    taskCompleteWithResult: 'Execution complete.\n\n{result}',
    taskFailed: 'Error: {error}',
    toolError: '{tool} exception: {error}',
    followUpProcessed: 'Follow-up executed.',
    followUpFailed: 'Follow-up exception: {error}',
    approvalNeeded: 'Awaiting user input.',
  },
  casual: {
    taskComplete: 'Nailed it.',
    taskCompleteWithResult: 'Nailed it.\n\n{result}',
    taskFailed: 'Uh oh: {error}',
    toolError: '{tool} had a moment: {error}',
    followUpProcessed: 'Check.',
    followUpFailed: 'That didn\'t work: {error}',
    approvalNeeded: 'Your call.',
  },
  custom: {
    taskComplete: 'Done.',
    taskCompleteWithResult: 'Done.\n\n{result}',
    taskFailed: 'Task failed: {error}',
    toolError: 'Tool error ({tool}): {error}',
    followUpProcessed: 'Follow-up complete.',
    followUpFailed: 'Follow-up failed: {error}',
    approvalNeeded: 'Approval needed.',
  },
};

/**
 * Emoji mappings for message types
 */
const EMOJI_MAP: Record<ChannelMessageKey, string> = {
  taskComplete: '✓',
  taskCompleteWithResult: '✓',
  taskFailed: '✗',
  toolError: '⚠',
  followUpProcessed: '✓',
  followUpFailed: '✗',
  approvalNeeded: '❓',
};

/**
 * Add emoji based on emojiUsage setting
 */
function addEmoji(message: string, key: ChannelMessageKey, emojiUsage: EmojiUsage): string {
  if (emojiUsage === 'none') return message;

  const emoji = EMOJI_MAP[key];
  if (!emoji) return message;

  // For minimal, only add checkmarks for success
  if (emojiUsage === 'minimal' && !['taskComplete', 'taskCompleteWithResult', 'followUpProcessed'].includes(key)) {
    return message;
  }

  return `${emoji} ${message}`;
}

/**
 * Get a personalized channel message
 */
export function getChannelMessage(
  key: ChannelMessageKey,
  ctx: ChannelMessageContext,
  replacements?: Record<string, string>
): string {
  const { personality, emojiUsage, quirks } = ctx;

  // Get base message for personality
  const messages = CHANNEL_MESSAGES[personality] || CHANNEL_MESSAGES.professional;
  let message = messages[key] || CHANNEL_MESSAGES.professional[key] || key;

  // Replace placeholders
  if (replacements) {
    for (const [placeholder, value] of Object.entries(replacements)) {
      message = message.replace(`{${placeholder}}`, value);
    }
  }

  // Add emoji if appropriate
  message = addEmoji(message, key, emojiUsage);

  // Add sign-off to completion messages
  if ((key === 'taskComplete' || key === 'taskCompleteWithResult') && quirks.signOff) {
    message = `${message}\n\n${quirks.signOff}`;
  }

  return message;
}

/**
 * Get completion message with optional result and follow-up hint
 * This is specific to channel messages which may include additional hints
 */
export function getCompletionMessage(
  ctx: ChannelMessageContext,
  result?: string,
  includeFollowUpHint = true
): string {
  const key: ChannelMessageKey = result ? 'taskCompleteWithResult' : 'taskComplete';
  let message = getChannelMessage(key, ctx, result ? { result } : undefined);

  // Add follow-up hint for channels that support it
  if (includeFollowUpHint && ctx.personality !== 'concise') {
    const hints: Record<PersonalityId, string> = {
      professional: 'Send a follow-up message to continue, or use /newtask to start fresh.',
      friendly: 'Got more to do? Just send another message!',
      concise: '',
      creative: 'The story continues... send your next chapter!',
      technical: 'Ready for next command. Use /newtask for new context.',
      casual: 'What\'s next? Just hit me up.',
      custom: 'Send a follow-up message to continue.',
    };
    const hint = hints[ctx.personality];
    if (hint) {
      message = `${message}\n\n${hint}`;
    }
  }

  return message;
}

/**
 * Default message context using professional personality
 */
export const DEFAULT_CHANNEL_CONTEXT: ChannelMessageContext = {
  agentName: 'CoWork',
  userName: undefined,
  personality: 'professional',
  emojiUsage: 'minimal',
  quirks: {
    catchphrase: undefined,
    signOff: undefined,
    analogyDomain: 'none',
  },
};

export default getChannelMessage;
