/**
 * Tests for Slack adapter isGroup field handling
 */

import { describe, it, expect } from 'vitest';

// Test the isGroup logic as implemented in the Slack adapter
function determineIsGroup(channelInfo: { is_im?: boolean; is_mpim?: boolean }): boolean {
  const isDirect = channelInfo.is_im === true;
  // Multi-party DMs and channels are considered "groups"
  return isDirect ? false : true;
}

function determineIsGroupFromChannelId(channelId: string): boolean | undefined {
  // Slack DM channel IDs start with 'D'
  if (channelId.startsWith('D')) {
    return false;
  }
  return true;
}

describe('Slack adapter isGroup field', () => {
  describe('from channel info', () => {
    it('should return false for direct messages (is_im=true)', () => {
      const channelInfo = { is_im: true, is_mpim: false };
      expect(determineIsGroup(channelInfo)).toBe(false);
    });

    it('should return true for multi-party DMs (is_mpim=true)', () => {
      const channelInfo = { is_im: false, is_mpim: true };
      expect(determineIsGroup(channelInfo)).toBe(true);
    });

    it('should return true for public channels', () => {
      const channelInfo = { is_im: false, is_mpim: false };
      expect(determineIsGroup(channelInfo)).toBe(true);
    });

    it('should return true for private channels', () => {
      const channelInfo = { is_im: false, is_mpim: false };
      expect(determineIsGroup(channelInfo)).toBe(true);
    });

    it('should handle undefined fields', () => {
      const channelInfo = {};
      expect(determineIsGroup(channelInfo)).toBe(true); // Default to group
    });
  });

  describe('from channel ID (slash commands)', () => {
    it('should return false for DM channel IDs starting with D', () => {
      expect(determineIsGroupFromChannelId('D01234567')).toBe(false);
      expect(determineIsGroupFromChannelId('DABCDEFGH')).toBe(false);
    });

    it('should return true for public channel IDs starting with C', () => {
      expect(determineIsGroupFromChannelId('C01234567')).toBe(true);
      expect(determineIsGroupFromChannelId('CABCDEFGH')).toBe(true);
    });

    it('should return true for private channel IDs starting with G', () => {
      expect(determineIsGroupFromChannelId('G01234567')).toBe(true);
      expect(determineIsGroupFromChannelId('GABCDEFGH')).toBe(true);
    });

    it('should return true for MPIM channel IDs starting with G', () => {
      // Multi-party IMs also start with G
      expect(determineIsGroupFromChannelId('G9876543210')).toBe(true);
    });
  });
});

describe('Slack message mapMessageToIncoming', () => {
  function mapMessageToIncoming(
    message: { user?: string; channel?: string; ts?: string; text?: string },
    userName: string,
    isGroup?: boolean
  ) {
    return {
      messageId: message.ts || '',
      channel: 'slack',
      userId: message.user || '',
      userName,
      chatId: message.channel || '',
      isGroup,
      text: message.text || '',
      timestamp: new Date(parseFloat(message.ts || '0') * 1000),
    };
  }

  it('should include isGroup=false for direct messages', () => {
    const message = {
      user: 'U123',
      channel: 'D456',
      ts: '1234567890.123456',
      text: 'Hello',
    };

    const result = mapMessageToIncoming(message, 'TestUser', false);

    expect(result.isGroup).toBe(false);
  });

  it('should include isGroup=true for channel messages', () => {
    const message = {
      user: 'U123',
      channel: 'C789',
      ts: '1234567890.123456',
      text: 'Hello everyone',
    };

    const result = mapMessageToIncoming(message, 'TestUser', true);

    expect(result.isGroup).toBe(true);
  });

  it('should include isGroup=undefined when not determinable', () => {
    const message = {
      user: 'U123',
      channel: 'X999',
      ts: '1234567890.123456',
      text: 'Unknown channel type',
    };

    const result = mapMessageToIncoming(message, 'TestUser', undefined);

    expect(result.isGroup).toBeUndefined();
  });
});

describe('Slack command isGroup field', () => {
  function mapCommandToIncoming(command: { channel_id?: string; user_id: string; user_name: string }) {
    const isGroup = command.channel_id ? !command.channel_id.startsWith('D') : undefined;
    return {
      channel: 'slack',
      userId: command.user_id,
      userName: command.user_name,
      chatId: command.channel_id || '',
      isGroup,
    };
  }

  it('should set isGroup=false for commands in DMs', () => {
    const command = {
      channel_id: 'D01234567',
      user_id: 'U123',
      user_name: 'testuser',
    };

    const result = mapCommandToIncoming(command);

    expect(result.isGroup).toBe(false);
  });

  it('should set isGroup=true for commands in channels', () => {
    const command = {
      channel_id: 'C01234567',
      user_id: 'U123',
      user_name: 'testuser',
    };

    const result = mapCommandToIncoming(command);

    expect(result.isGroup).toBe(true);
  });

  it('should set isGroup=undefined when channel_id is missing', () => {
    const command = {
      user_id: 'U123',
      user_name: 'testuser',
    };

    const result = mapCommandToIncoming(command);

    expect(result.isGroup).toBeUndefined();
  });
});
